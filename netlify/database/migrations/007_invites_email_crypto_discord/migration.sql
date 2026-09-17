-- Invite-only registration, encrypted emails, Discord reminder IDs,
-- and onboarding + power stats. Existing members are treated as already onboarded.

CREATE TABLE IF NOT EXISTS invite_codes (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_active ON invite_codes(active, created_at DESC);

ALTER TABLE users ALTER COLUMN player_name DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS player_stats JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_lookup_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lookup
  ON users(email_lookup_hash)
  WHERE email_lookup_hash IS NOT NULL;

ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Anyone who already has a portal row finished the old signup path.
UPDATE users
SET onboarding_complete = TRUE
WHERE onboarding_complete = FALSE
  AND (player_name IS NOT NULL OR password_hash IS NOT NULL OR identity_id IS NOT NULL);
