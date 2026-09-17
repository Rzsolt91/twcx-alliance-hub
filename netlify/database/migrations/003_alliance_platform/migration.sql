-- 003: full alliance platform extension (squads/signups/calendar/VS/community/uploads)
-- Timezone offsets are stored as text (some zones use fractional offsets).

-- Personal profile for each registered user (timezone, language, notification email)
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Etc/GMT';
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email TEXT;

-- Numeric aliases for player rank ('R4'/'R3') used in progress calculations
ALTER TABLE players ADD COLUMN IF NOT EXISTS rank_level NUMERIC(10,2) NOT NULL DEFAULT 3;

-- Log of every power update, so players can track their own progression
CREATE TABLE IF NOT EXISTS player_progress (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  squad TEXT NOT NULL CHECK (squad IN ('AIR','TANK','MISSILE')),
  power NUMERIC(14,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_progress_player ON player_progress(player_id, recorded_at);

-- Weekly recurring storm events (Canyon Storm / Desert Storm slots)
CREATE TABLE IF NOT EXISTS weekly_events (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  server_time TIME NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Event signups (alliance members register for weekly storms)
CREATE TABLE IF NOT EXISTS event_signups (
  id BIGSERIAL PRIMARY KEY,
  weekly_event_id BIGINT NOT NULL REFERENCES weekly_events(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','APPROVED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (weekly_event_id, player_id, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_event_signups_date ON event_signups(occurrence_date);

-- Teams assembled by R4/Master for each occurrence
CREATE TABLE IF NOT EXISTS event_teams (
  id BIGSERIAL PRIMARY KEY,
  weekly_event_id BIGINT NOT NULL REFERENCES weekly_events(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  team_name TEXT NOT NULL,
  member_names JSONB NOT NULL DEFAULT '[]',
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Calendar events (manual daily events created by Master/R4)
CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  server_time TIME NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'OTHER' CHECK (category IN ('OTHER','VS','GE','GEW','OTHER_GAME','ALLIANCE')),
  created_by BIGINT REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_active_date ON calendar_events(active, event_date);

-- Reminder subscriptions ("remind me about this event")
CREATE TABLE IF NOT EXISTS calendar_reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('WEEKLY','CALENDAR')),
  event_id BIGINT NOT NULL,
  UNIQUE (user_id, event_kind, event_id)
);

-- Uploaded strategy images / war plans (bytes stored in Netlify Blobs)
CREATE TABLE IF NOT EXISTS strategy_images (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'EVENT' CHECK (category IN ('EVENT','VS','SITE','EXCEL')),
  event_id BIGINT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  blob_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_strategy_images_category ON strategy_images(category, event_id);

-- VS weeks (push/save), opponents and strategies
CREATE TABLE IF NOT EXISTS vs_weeks (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL UNIQUE,
  week_type TEXT NOT NULL CHECK (week_type IN ('PUSH','SAVE')),
  opponent TEXT,
  strategy_image_id BIGINT REFERENCES strategy_images(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Points scored by each player in a VS week
CREATE TABLE IF NOT EXISTS vs_points (
  id BIGSERIAL PRIMARY KEY,
  vs_week_id BIGINT NOT NULL REFERENCES vs_weeks(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  points NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE (vs_week_id, player_id)
);

-- Community: memes and funny photos with likes (weekly contest)
CREATE TABLE IF NOT EXISTS community_posts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  blob_key TEXT,
  mime_type TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  week_start DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_week ON community_posts(week_start, likes DESC);

CREATE TABLE IF NOT EXISTS community_likes (
  user_id BIGINT NOT NULL REFERENCES users(id),
  post_id BIGINT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, post_id)
);

-- Community: suggestions and complaints
CREATE TABLE IF NOT EXISTS community_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('SUGGESTION','COMPLAINT')),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Community: games, quizzes and contests with a leaderboard
CREATE TABLE IF NOT EXISTS community_games (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_scores (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES community_games(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_scores_game ON community_scores(game_id, score DESC);

-- Site content (edit in place by Master: hero text, welcome messages, logo images)
CREATE TABLE IF NOT EXISTS site_content (
  id BIGSERIAL PRIMARY KEY,
  section TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_id BIGINT REFERENCES strategy_images(id),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO weekly_events (code,title,weekday,server_time,description) VALUES
  ('canyon-1200','Canyon Storm',4,'12:00','First Canyon Storm slot of Thursday (server time).'),
  ('canyon-2300','Canyon Storm',4,'23:00','Second Canyon Storm slot of Thursday (server time).'),
  ('desert-0900','Desert Storm',3,'09:00','First Desert Storm slot of Wednesday (server time).'),
  ('desert-1800','Desert Storm',3,'18:00','Second Desert Storm slot of Wednesday (server time).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO site_content (section,title,body) VALUES
  ('home','Command center','Alliance operations at a glance.')
ON CONFLICT (section) DO NOTHING;

INSERT INTO community_games (title,description)
SELECT 'Weekly Quiz','Alliance quiz: score points and climb the weekly leaderboard.'
WHERE NOT EXISTS (SELECT 1 FROM community_games);
