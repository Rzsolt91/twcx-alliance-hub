import type { Config } from "@netlify/functions";
import { msUntilNextReminder, runReminderPass } from "../lib/reminders.js";

export { msUntilNextReminder, runReminderPass };

/**
 * Reminder pass. Local `npm run dev` arms a single timer for T-5.
 * Production cannot sleep until then, so this function also runs on a
 * five-minute schedule; runReminderPass itself no-ops outside the send window.
 */
export default async () => {
  try {
    const summary = await runReminderPass();
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (error) {
    console.error("discord-reminders failed", error);
    return new Response(JSON.stringify({ error: "reminder pass failed" }), { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
