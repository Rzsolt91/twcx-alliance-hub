import type { Account } from "../auth.js";
import { canManage, requireManage, requireModule } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { HttpError, integer, isoDate, ok, oneOf, readJson, text } from "../http.js";
import type { RouteTable } from "../router.js";
import { deleteUpload, readMultipart } from "../uploads.js";
import { serverWallClock, serverWeekStart, shiftServerDate } from "../../../shared/time.js";

const FEEDBACK_KINDS = ["SUGGESTION", "COMPLAINT"] as const;
const ACTIVITY_KINDS = ["QUIZ", "CONTEST", "GAME"] as const;

function resolveWeek(url: URL) {
  const requested = url.searchParams.get("week");
  return serverWeekStart(requested ? isoDate(requested, "Week") : serverWallClock().date);
}

/** GET /api/community — the meme board, feedback, activities and leaderboards. */
async function overview(account: Account, url: URL) {
  requireModule(account, "community");
  const weekStart = resolveWeek(url);
  const manage = canManage(account);

  const posts = await query(
    `SELECT p.id, p.title, p.description, p.blob_key, p.mime_type, p.likes, p.week_start::text AS week_start, p.created_at,
            u.player_name AS author, p.user_id,
            EXISTS (SELECT 1 FROM community_likes l WHERE l.post_id = p.id AND l.user_id = $2) AS liked
     FROM community_posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.active = TRUE AND p.week_start = $1
     ORDER BY p.likes DESC, p.created_at DESC`,
    [weekStart, account.id],
  );

  const winner = await queryOne(
    `SELECT w.week_start::text AS week_start, w.prize, p.title, p.id AS post_id, u.player_name AS author
     FROM community_contest_winners w
     JOIN community_posts p ON p.id = w.post_id
     JOIN users u ON u.id = p.user_id
     WHERE w.week_start = $1`,
    [weekStart],
  );

  // Members see their own reports; Master and R4 see the whole queue.
  const feedback = await query(
    `SELECT f.id, f.kind, f.subject, f.message, f.status, f.created_at, u.player_name AS author, f.user_id
     FROM community_feedback f
     JOIN users u ON u.id = f.user_id
     WHERE $2 OR f.user_id = $1
     ORDER BY f.status, f.created_at DESC
     LIMIT 200`,
    [account.id, manage],
  );

  const activities = await query(
    `SELECT g.id, g.title, g.description, g.kind, g.closes_on::text AS closes_on, g.active,
            COALESCE(s.entries, 0) AS entries,
            COALESCE(mine.score, NULL) AS my_score
     FROM community_games g
     LEFT JOIN (
       SELECT game_id, count(*)::int AS entries FROM community_scores GROUP BY game_id
     ) s ON s.game_id = g.id
     LEFT JOIN community_scores mine ON mine.game_id = g.id AND mine.user_id = $1
     WHERE g.active = TRUE
     ORDER BY g.created_at DESC`,
    [account.id],
  );

  const leaderboard = await query(
    `SELECT u.player_name AS name, SUM(s.score)::int AS score, count(*)::int AS played
     FROM community_scores s
     JOIN users u ON u.id = s.user_id
     GROUP BY u.player_name
     ORDER BY score DESC, name
     LIMIT 25`,
  );

  return ok({
    weekStart,
    previousWeek: shiftServerDate(weekStart, -7),
    nextWeek: shiftServerDate(weekStart, 7),
    currentWeek: serverWeekStart(serverWallClock().date),
    canManage: manage,
    posts: posts.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      imageId: row.blob_key ? row.id : null,
      mimeType: row.mime_type,
      likes: Number(row.likes),
      liked: row.liked,
      author: row.author,
      mine: row.user_id === account.id,
      createdAt: row.created_at,
    })),
    winner: winner
      ? { postId: winner.post_id, title: winner.title, author: winner.author, prize: winner.prize }
      : null,
    feedback: feedback.map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      message: row.message,
      status: row.status,
      author: row.author,
      mine: row.user_id === account.id,
      createdAt: row.created_at,
    })),
    activities: activities.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      kind: row.kind,
      closesOn: row.closes_on ? String(row.closes_on).slice(0, 10) : null,
      entries: Number(row.entries),
      myScore: row.my_score === null ? null : Number(row.my_score),
    })),
    leaderboard: leaderboard.map((row) => ({
      name: row.name,
      score: Number(row.score),
      played: Number(row.played),
    })),
  });
}

/** POST /api/community/posts — upload a meme into this week's contest. */
async function createPost(account: Account, req: Request) {
  requireModule(account, "community");
  const { fields, file } = await readMultipart(req, "image", "image");
  const title = text(fields.title, "Title", { max: 120, required: true });
  const description = text(fields.description, "Description", { max: 600 });
  if (!file) throw new HttpError("Attach an image for the contest.", 422);

  const weekStart = serverWeekStart(serverWallClock().date);
  const created = await query<{ id: number }>(
    `INSERT INTO community_posts (user_id, title, description, blob_key, mime_type, week_start)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [account.id, title, description, file.key, file.mimeType, weekStart],
  );
  return ok({ id: created[0].id });
}

/** DELETE /api/community/posts?id= — authors and managers can remove a post. */
async function removePost(account: Account, url: URL) {
  requireModule(account, "community");
  const id = integer(url.searchParams.get("id"), "Post id", { min: 1 });

  const post = await queryOne<{ user_id: number; blob_key: string | null }>(
    "SELECT user_id, blob_key FROM community_posts WHERE id = $1",
    [id],
  );
  if (!post) throw new HttpError("Post not found.", 404);
  if (post.user_id !== account.id && !canManage(account)) {
    throw new HttpError("You can only remove your own post.", 403);
  }

  await query("UPDATE community_posts SET active = FALSE WHERE id = $1", [id]);
  if (post.blob_key) await deleteUpload(post.blob_key);
  return ok({ id });
}

/** POST /api/community/likes — one like per member, toggled. */
async function toggleLike(account: Account, req: Request) {
  requireModule(account, "community");
  const body = await readJson(req);
  const postId = integer(body.postId, "Post id", { min: 1 });

  const result = await transaction(async (client) => {
    const post = await client.query("SELECT 1 FROM community_posts WHERE id = $1 AND active = TRUE", [postId]);
    if (!post.rows[0]) throw new HttpError("Post not found.", 404);

    const inserted = await client.query(
      `INSERT INTO community_likes (user_id, post_id) VALUES ($1, $2)
       ON CONFLICT (user_id, post_id) DO NOTHING RETURNING post_id`,
      [account.id, postId],
    );

    if (inserted.rows[0]) {
      const row = await client.query(
        "UPDATE community_posts SET likes = likes + 1 WHERE id = $1 RETURNING likes",
        [postId],
      );
      return { liked: true, likes: Number(row.rows[0].likes) };
    }

    await client.query("DELETE FROM community_likes WHERE user_id = $1 AND post_id = $2", [account.id, postId]);
    const row = await client.query(
      "UPDATE community_posts SET likes = GREATEST(likes - 1, 0) WHERE id = $1 RETURNING likes",
      [postId],
    );
    return { liked: false, likes: Number(row.rows[0].likes) };
  });

  return ok({ postId, ...result });
}

/** POST /api/community/winner — R4/Master award the weekly prize. */
async function awardWinner(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const postId = integer(body.postId, "Post id", { min: 1 });
  const prize = text(body.prize, "Prize", { max: 160 });

  const post = await queryOne<{ week_start: string }>(
    "SELECT week_start::text AS week_start FROM community_posts WHERE id = $1 AND active = TRUE",
    [postId],
  );
  if (!post) throw new HttpError("Post not found.", 404);

  await query(
    `INSERT INTO community_contest_winners (week_start, post_id, prize, awarded_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (week_start) DO UPDATE SET
       post_id = EXCLUDED.post_id, prize = EXCLUDED.prize, awarded_by = EXCLUDED.awarded_by, awarded_at = NOW()`,
    [String(post.week_start).slice(0, 10), postId, prize, account.id],
  );
  return ok({ postId });
}

/** POST /api/community/feedback — file a suggestion or a complaint. */
async function createFeedback(account: Account, req: Request) {
  requireModule(account, "community");
  const body = await readJson(req);
  const kind = oneOf(body.kind, FEEDBACK_KINDS, "Kind");
  const subject = text(body.subject, "Subject", { max: 140, required: true });
  const message = text(body.message, "Message", { max: 3000, required: true });

  const created = await query<{ id: number }>(
    `INSERT INTO community_feedback (user_id, kind, subject, message) VALUES ($1, $2, $3, $4) RETURNING id`,
    [account.id, kind, subject, message],
  );
  return ok({ id: created[0].id });
}

/** PATCH /api/community/feedback — R4/Master close a report. */
async function resolveFeedback(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const id = integer(body.id, "Report id", { min: 1 });
  const status = oneOf(body.status, ["OPEN", "RESOLVED"], "Status");

  const updated = await query("UPDATE community_feedback SET status = $1 WHERE id = $2 RETURNING id", [status, id]);
  if (!updated[0]) throw new HttpError("Report not found.", 404);
  return ok({ id, status });
}

/** POST /api/community/games — R4/Master publish a quiz, contest or game. */
async function saveActivity(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const title = text(body.title, "Title", { max: 120, required: true });
  const description = text(body.description, "Description", { max: 2000 });
  const kind = oneOf(body.kind ?? "QUIZ", ACTIVITY_KINDS, "Kind");
  const closesOn = body.closesOn ? isoDate(body.closesOn, "Closing date") : null;

  if (body.id) {
    const id = integer(body.id, "Activity id", { min: 1 });
    const updated = await query(
      `UPDATE community_games SET title = $1, description = $2, kind = $3, closes_on = $4
       WHERE id = $5 RETURNING id`,
      [title, description, kind, closesOn, id],
    );
    if (!updated[0]) throw new HttpError("Activity not found.", 404);
    return ok({ id });
  }

  const created = await query<{ id: number }>(
    `INSERT INTO community_games (title, description, kind, closes_on) VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, description, kind, closesOn],
  );
  return ok({ id: created[0].id });
}

/** DELETE /api/community/games?id= */
async function removeActivity(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "Activity id", { min: 1 });
  const removed = await query("UPDATE community_games SET active = FALSE WHERE id = $1 RETURNING id", [id]);
  if (!removed[0]) throw new HttpError("Activity not found.", 404);
  return ok({ id });
}

/** POST /api/community/scores — record the caller's result in an activity. */
async function submitScore(account: Account, req: Request) {
  requireModule(account, "community");
  const body = await readJson(req);
  const gameId = integer(body.gameId, "Activity id", { min: 1 });
  const score = integer(body.score, "Score", { min: 0, max: 1_000_000 });

  const activity = await queryOne<{ closes_on: string | null }>(
    "SELECT closes_on::text AS closes_on FROM community_games WHERE id = $1 AND active = TRUE",
    [gameId],
  );
  if (!activity) throw new HttpError("Activity not found.", 404);
  if (activity.closes_on && String(activity.closes_on).slice(0, 10) < serverWallClock().date) {
    throw new HttpError("This activity is closed.", 409);
  }

  await query(
    `INSERT INTO community_scores (game_id, user_id, score) VALUES ($1, $2, $3)
     ON CONFLICT (game_id, user_id) DO UPDATE SET score = GREATEST(community_scores.score, EXCLUDED.score)`,
    [gameId, account.id, score],
  );
  return ok({ gameId, score });
}

export const communityRoutes: RouteTable = {
  "GET community": ({ account, url }) => overview(account, url),
  "POST community/posts": ({ account, req }) => createPost(account, req),
  "DELETE community/posts": ({ account, url }) => removePost(account, url),
  "POST community/likes": ({ account, req }) => toggleLike(account, req),
  "POST community/winner": ({ account, req }) => awardWinner(account, req),
  "POST community/feedback": ({ account, req }) => createFeedback(account, req),
  "PATCH community/feedback": ({ account, req }) => resolveFeedback(account, req),
  "POST community/games": ({ account, req }) => saveActivity(account, req),
  "DELETE community/games": ({ account, url }) => removeActivity(account, url),
  "POST community/scores": ({ account, req }) => submitScore(account, req),
};
