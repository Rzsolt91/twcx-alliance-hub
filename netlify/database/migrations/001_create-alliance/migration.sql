CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  player_name TEXT UNIQUE NOT NULL,
  identity_id TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'R3' CHECK (role IN ('MASTER','R4','R3')),
  allowed_modules JSONB NOT NULL DEFAULT '["home","squads","events","calendar"]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE players (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  rank TEXT NOT NULL DEFAULT 'R3' CHECK (rank IN ('R4','R3')),
  main_squad TEXT NOT NULL DEFAULT 'AIR' CHECK (main_squad IN ('AIR','TANK','MISSILE')),
  air_power NUMERIC(14,2) NOT NULL DEFAULT 0,
  tank_power NUMERIC(14,2) NOT NULL DEFAULT 0,
  missile_power NUMERIC(14,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_players_active_name ON players(active,name);
CREATE TABLE alliance_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  server_time TIME NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 50 CHECK (capacity > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_active_date_time ON alliance_events(active,event_date,server_time);
