-- Track Discord DMs for one-off calendar events (storm signups already use event_signups.reminder_sent_at).

ALTER TABLE calendar_reminders
  ADD COLUMN IF NOT EXISTS discord_sent_at TIMESTAMPTZ;
