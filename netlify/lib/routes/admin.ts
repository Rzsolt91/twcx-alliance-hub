import type { Account } from "../auth.js";
import { MODULES, ROLES, canManage, requireManage, requireMaster } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { revealEmail } from "../emails.js";
import { boolean, HttpError, integer, ok, oneOf, readJson, text } from "../http.js";
import { randomInviteCode } from "../invites.js";
import { assertPasswordStrength, hashPassword } from "../passwords.js";
import type { RouteTable } from "../router.js";
import { endAllSessions } from "../sessions.js";

/** GET /api/admin/users — the account list, visible to Master and R4. */
async function listUsers(account: Account) {
  requireManage(account);

  const users = await query(
    `SELECT u.id, u.email, u.email_encrypted, u.player_name, u.login_name, u.role, u.allowed_modules,
            u.timezone, u.language, u.created_at, (u.password_hash IS NOT NULL) AS has_password,
            p.id AS player_id,
            (p.air_power + p.tank_power + p.missile_power) AS total_power
     FROM users u
     LEFT JOIN players p ON p.user_id = u.id AND p.active = TRUE
     WHERE u.active = TRUE
     ORDER BY
       CASE u.role WHEN 'MASTER' THEN 0 WHEN 'R4' THEN 1 ELSE 2 END,
       u.player_name`,
  );

  return ok({
    modules: MODULES,
    roles: ROLES,
    canEditRoles: account.role === "MASTER",
    users: users.map((row) => ({
      id: row.id,
      email: revealEmail(row),
      playerName: row.player_name,
      loginName: row.login_name,
      hasPassword: row.has_password === true,
      role: row.role,
      allowedModules: Array.isArray(row.allowed_modules) ? row.allowed_modules : [],
      timezone: row.timezone,
      language: row.language,
      playerId: row.player_id,
      totalPower: row.total_power === null ? null : Number(row.total_power),
      createdAt: row.created_at,
      isSelf: row.id === account.id,
    })),
  });
}

/**
 * PATCH /api/admin/users — Master only: set a role and, for R3 accounts, the
 * sections that account is allowed to open.
 */
async function updateUser(account: Account, req: Request) {
  requireMaster(account);
  const body = await readJson(req);
  const id = integer(body.id, "Account id", { min: 1 });
  const role = oneOf(body.role, ROLES, "Role");
  const requested = Array.isArray(body.allowedModules) ? body.allowedModules.map(String) : [];
  const allowedModules = MODULES.filter((module) => module === "home" || requested.includes(module));

  const target = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1 AND active = TRUE", [id]);
  if (!target) throw new HttpError("Account not found.", 404);

  await transaction(async (client) => {
    // The alliance must never be left without a Master.
    if (target.role === "MASTER" && role !== "MASTER") {
      const remaining = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users WHERE role = 'MASTER' AND active = TRUE AND id <> $1",
        [id],
      );
      if (remaining.rows[0].count === 0) {
        throw new HttpError("Promote another Master before stepping this one down.", 409);
      }
    }

    await client.query("UPDATE users SET role = $1, allowed_modules = $2 WHERE id = $3", [
      role,
      JSON.stringify(allowedModules),
      id,
    ]);

    // Keep the roster rank in step with the account role.
    await client.query("UPDATE players SET rank = $1, rank_level = $2 WHERE user_id = $3", [
      role === "R3" ? "R3" : "R4",
      role === "R3" ? 3 : 4,
      id,
    ]);
  });

  return ok({ id, role, allowedModules });
}

/** DELETE /api/admin/users?id= — Master only: revoke portal access. */
async function deactivateUser(account: Account, url: URL) {
  requireMaster(account);
  const id = integer(url.searchParams.get("id"), "Account id", { min: 1 });
  if (id === account.id) throw new HttpError("You cannot deactivate your own account.", 409);

  const target = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1 AND active = TRUE", [id]);
  if (!target) throw new HttpError("Account not found.", 404);
  if (target.role === "MASTER") {
    const remaining = await queryOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE role = 'MASTER' AND active = TRUE AND id <> $1",
      [id],
    );
    if ((remaining?.count ?? 0) === 0) throw new HttpError("The alliance needs at least one Master.", 409);
  }

  await query("UPDATE users SET active = FALSE WHERE id = $1", [id]);
  return ok({ id });
}

/** GET /api/content — editable copy and hero images for each section. */
async function readContent(account: Account) {
  const rows = await query(
    `SELECT c.section, c.title, c.body, c.image_id, c.updated_at, u.player_name AS editor
     FROM site_content c
     LEFT JOIN users u ON u.id = c.updated_by
     ORDER BY c.section`,
  );

  const sections: Record<string, unknown> = {};
  for (const row of rows) {
    sections[row.section] = {
      section: row.section,
      title: row.title,
      body: row.body,
      imageId: row.image_id,
      editor: row.editor,
      updatedAt: row.updated_at,
    };
  }
  return ok({ sections, canEdit: canManage(account) });
}

/** PATCH /api/content — R4/Master edit copy and swap the section image. */
async function updateContent(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const section = text(body.section, "Section", { max: 40, required: true }).toLowerCase();
  const title = text(body.title, "Title", { max: 140 });
  const copy = text(body.body, "Body", { max: 4000 });
  const imageId = body.imageId === null || body.imageId === "" ? null : integer(body.imageId, "Image", { min: 1 });

  if (imageId) {
    const image = await queryOne("SELECT 1 FROM strategy_images WHERE id = $1", [imageId]);
    if (!image) throw new HttpError("Image not found.", 404);
  }

  await query(
    `INSERT INTO site_content (section, title, body, image_id, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (section) DO UPDATE SET
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       image_id = EXCLUDED.image_id,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [section, title, copy, imageId, account.id],
  );
  return ok({ section });
}

/**
 * PATCH /api/admin/users/password — Master only: set a new password for a
 * member.
 *
 * A player-name account has no email, so there is no self-service reset to
 * fall back on; the Master hands out a temporary password instead. Every
 * existing session for that member is dropped so a stolen cookie cannot
 * outlive the reset.
 */
async function resetPassword(account: Account, req: Request) {
  requireMaster(account);
  const body = await readJson(req);
  const id = integer(body.id, "Account id", { min: 1 });
  const password = String(body.password ?? "");
  assertPasswordStrength(password, "New password");

  const target = await queryOne<{ player_name: string; login_name: string | null }>(
    "SELECT player_name, login_name FROM users WHERE id = $1 AND active = TRUE",
    [id],
  );
  if (!target) throw new HttpError("Account not found.", 404);

  // An email-only account gains a sign-in name here, so the reset password is
  // actually usable.
  const reserve =
    target.login_name === null
      ? !(
          await queryOne<{ taken: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM users WHERE login_name = $1) AS taken",
            [target.player_name.toLowerCase()],
          )
        )?.taken
      : false;

  await query(
    `UPDATE users SET password_hash = $1, password_set_at = NOW(),
       login_name = COALESCE(login_name, $3)
     WHERE id = $2`,
    [await hashPassword(password), id, reserve ? target.player_name.toLowerCase() : null],
  );
  await endAllSessions(id);

  return ok({ id, loginName: target.login_name ?? (reserve ? target.player_name.toLowerCase() : null) });
}

/* ---------------------------------------------------------- invite codes --- */

function shapeInvite(row: {
  id: number;
  code: string;
  active: boolean;
  note: string;
  created_at: string;
  creator: string | null;
}) {
  return {
    id: row.id,
    code: row.code,
    active: row.active === true,
    note: row.note || "",
    createdAt: row.created_at,
    createdBy: row.creator,
  };
}

/** GET /api/admin/invite-codes — every invite, including revoked ones. */
async function listInvites(account: Account) {
  requireManage(account);
  const rows = await query<{
    id: number;
    code: string;
    active: boolean;
    note: string;
    created_at: string;
    creator: string | null;
  }>(
    `SELECT i.id, i.code, i.active, i.note, i.created_at, u.player_name AS creator
     FROM invite_codes i
     LEFT JOIN users u ON u.id = i.created_by
     ORDER BY i.created_at DESC`,
  );
  return ok({ invites: rows.map(shapeInvite) });
}

/** POST /api/admin/invite-codes — mint a new code. */
async function createInvite(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const note = text(body.note, "Note", { max: 200 });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomInviteCode();
    try {
      const created = await queryOne<{
        id: number;
        code: string;
        active: boolean;
        note: string;
        created_at: string;
      }>(
        `INSERT INTO invite_codes (code, created_by, note)
         VALUES ($1, $2, $3)
         RETURNING id, code, active, note, created_at`,
        [code, account.id, note],
      );
      return ok(shapeInvite({ ...created!, creator: account.player_name }), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/unique|duplicate/i.test(message) || attempt === 7) throw error;
    }
  }
  throw new HttpError("Could not generate an invite code.", 500);
}

/** PATCH /api/admin/invite-codes/:id — toggle active/inactive. */
async function updateInvite(account: Account, params: Record<string, string>, req: Request) {
  requireManage(account);
  const id = integer(params.id, "Invite id", { min: 1 });
  const body = await readJson(req);
  if (body.active === undefined) throw new HttpError("active is required.", 422);
  const active = boolean(body.active);

  const updated = await queryOne<{
    id: number;
    code: string;
    active: boolean;
    note: string;
    created_at: string;
    creator: string | null;
  }>(
    `UPDATE invite_codes i
     SET active = $1
     WHERE i.id = $2
     RETURNING i.id, i.code, i.active, i.note, i.created_at,
       (SELECT u.player_name FROM users u WHERE u.id = i.created_by) AS creator`,
    [active, id],
  );
  if (!updated) throw new HttpError("Invite code not found.", 404);
  return ok(shapeInvite(updated));
}

export const adminRoutes: RouteTable = {
  "GET admin/users": ({ account }) => listUsers(account),
  "PATCH admin/users": ({ account, req }) => updateUser(account, req),
  "DELETE admin/users": ({ account, url }) => deactivateUser(account, url),
  "PATCH admin/users/password": ({ account, req }) => resetPassword(account, req),
  "GET admin/invite-codes": ({ account }) => listInvites(account),
  "POST admin/invite-codes": ({ account, req }) => createInvite(account, req),
  "PATCH admin/invite-codes/:id": ({ account, params, req }) => updateInvite(account, params, req),
  "GET content": ({ account }) => readContent(account),
  "PATCH content": ({ account, req }) => updateContent(account, req),
};
