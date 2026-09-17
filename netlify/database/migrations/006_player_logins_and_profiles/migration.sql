-- 006: player-name logins, profile photos and THP.
--
-- Until now an account could only exist behind a Netlify Identity email. The
-- alliance signs up with in-game names, so this adds native credentials
-- (player name + password) alongside Identity, a profile photo per account and
-- a THP (total hero power) reading per roster row.
--
-- Rolls forward only: 001-005 are untouched and Identity accounts keep working.

-- An account created with a player name has no email and no Identity user, so
-- both columns have to accept NULL. The UNIQUE constraints stay (Postgres
-- allows many NULLs in a unique index).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN identity_id DROP NOT NULL;

-- Native credentials. `login_name` is the case-folded player name used to look
-- an account up at sign-in; `password_hash` is PBKDF2-SHA256, never a secret in
-- plain text. Identity-only accounts keep a NULL hash and sign in by email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_name ON users(login_name) WHERE login_name IS NOT NULL;

-- Profile photo, stored in Netlify Blobs with the key recorded here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_blob_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;

-- Reserve the in-game name of every existing account as its login name, so a
-- member who registered by email can also sign in by name once they set a
-- password. Names that differ only by case are skipped rather than colliding.
UPDATE users u
SET login_name = lower(u.player_name)
WHERE u.login_name IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM users other
    WHERE other.id <> u.id
      AND lower(other.player_name) = lower(u.player_name)
  );

-- Sign-in sessions for native logins. Only the SHA-256 of the cookie token is
-- stored, so a database read cannot be replayed as a session.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

-- THP (total hero power) sits next to the three squad powers on the roster.
ALTER TABLE players ADD COLUMN IF NOT EXISTS thp NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Let the progress log carry THP readings too, so hero power can be charted
-- the same way squad power already is.
ALTER TABLE player_progress DROP CONSTRAINT IF EXISTS player_progress_squad_check;
ALTER TABLE player_progress ADD CONSTRAINT player_progress_squad_check
  CHECK (squad IN ('AIR','TANK','MISSILE','THP'));
