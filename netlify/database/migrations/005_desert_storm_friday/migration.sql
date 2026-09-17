-- 005: Desert Storm runs on Fridays, not Wednesdays.
--
-- 003 seeded both Desert Storm slots on weekday 3 (Wednesday). The storm
-- actually runs every Friday, so roll the slots forward two days and carry the
-- applications and teams already filed for a future occurrence over to the
-- matching Friday, instead of leaving them stranded on a date the slot no
-- longer runs on. Occurrences up to today stay put as history, and a slot an
-- R4 has already retimed by hand is left alone.

-- Applications for occurrences that have not happened yet. The guard keeps the
-- (event, player, date) uniqueness intact if a member somehow already holds the
-- Friday date.
UPDATE event_signups s
SET occurrence_date = s.occurrence_date + 2
FROM weekly_events e
WHERE e.id = s.weekly_event_id
  AND e.code IN ('desert-0900', 'desert-1800')
  AND e.weekday = 3
  AND s.occurrence_date > CURRENT_DATE
  AND NOT EXISTS (
    SELECT 1
    FROM event_signups other
    WHERE other.weekly_event_id = s.weekly_event_id
      AND other.player_id = s.player_id
      AND other.occurrence_date = s.occurrence_date + 2
  );

-- Teams published for those same future occurrences.
UPDATE event_teams t
SET occurrence_date = t.occurrence_date + 2
FROM weekly_events e
WHERE e.id = t.weekly_event_id
  AND e.code IN ('desert-0900', 'desert-1800')
  AND e.weekday = 3
  AND t.occurrence_date > CURRENT_DATE;

-- The slots themselves. `replace` fixes the seeded wording while leaving any
-- description an R4 has customised otherwise intact.
UPDATE weekly_events
SET weekday = 5,
    description = replace(description, 'Wednesday', 'Friday')
WHERE code IN ('desert-0900', 'desert-1800')
  AND weekday = 3;
