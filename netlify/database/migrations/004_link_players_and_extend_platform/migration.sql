-- 004: rebuild support — link player rows to user accounts and fill gaps
-- needed by the rebuilt portal. Rolls forward only; 001-003 are untouched.

-- A player roster row can belong to a registered account, so a member can
-- update their own squad power without R4 having to do it for them.
ALTER TABLE players ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_user ON players(user_id) WHERE user_id IS NOT NULL;

-- Which squad a member brings to a storm occurrence (helps R4 build teams).
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS squad TEXT
  CHECK (squad IS NULL OR squad IN ('AIR','TANK','MISSILE'));
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';

-- Free-text strategy for a team, alongside the uploaded plan images.
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- VS week strategy text (images already covered by strategy_image_id).
ALTER TABLE vs_weeks ADD COLUMN IF NOT EXISTS strategy_notes TEXT NOT NULL DEFAULT '';

-- Uploads: keep the original file name and size so spreadsheets can be
-- listed and downloaded with a sensible name.
ALTER TABLE strategy_images ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE strategy_images ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;

-- Community activities are quizzes, contests or plain games.
ALTER TABLE community_games ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'QUIZ'
  CHECK (kind IN ('QUIZ','CONTEST','GAME'));
ALTER TABLE community_games ADD COLUMN IF NOT EXISTS closes_on DATE;

-- One score per member per activity, so the leaderboard cannot be farmed.
DELETE FROM community_scores s
USING community_scores keep
WHERE s.game_id = keep.game_id
  AND s.user_id = keep.user_id
  AND s.id > keep.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_scores_unique ON community_scores(game_id, user_id);

-- Weekly meme contest winners, so a past prize stays recorded even after
-- likes keep moving.
CREATE TABLE IF NOT EXISTS community_contest_winners (
  week_start DATE PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  prize TEXT NOT NULL DEFAULT '',
  awarded_by BIGINT REFERENCES users(id),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Back-fill the account link for rows created before this migration, where the
-- roster name still matches the account player name exactly.
UPDATE players p
SET user_id = u.id
FROM users u
WHERE p.user_id IS NULL
  AND p.name = u.player_name
  AND NOT EXISTS (SELECT 1 FROM players other WHERE other.user_id = u.id);

-- Seed the remaining editable site sections used by the rebuilt front end.
INSERT INTO site_content (section,title,body) VALUES
  ('gate','TWCX Alliance','Operations portal for the alliance. Sign in to reach the command center.'),
  ('events','Storm operations','Apply for the weekly storms. All listed clocks are server time.'),
  ('vs','VS duel','Push weeks and save weeks, opponent of the week and scored points.'),
  ('community','Alliance lounge','Suggestions, contests and the weekly meme board.')
ON CONFLICT (section) DO NOTHING;
