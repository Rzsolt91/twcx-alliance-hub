-- Storm team A / B / Both, as the BLO generator reads it from a signup sheet.

ALTER TABLE event_signups
  ADD COLUMN IF NOT EXISTS storm_team TEXT NOT NULL DEFAULT 'BOTH';

ALTER TABLE event_signups
  DROP CONSTRAINT IF EXISTS event_signups_storm_team_check;

ALTER TABLE event_signups
  ADD CONSTRAINT event_signups_storm_team_check
  CHECK (storm_team IN ('A', 'B', 'BOTH'));
