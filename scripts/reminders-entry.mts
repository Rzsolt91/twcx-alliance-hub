import { msUntilNextReminder, runReminderPass } from "../netlify/lib/reminders.ts";

export { msUntilNextReminder, runReminderPass };

export default async () => runReminderPass();
