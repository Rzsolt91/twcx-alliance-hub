# TWCX Alliance Hub

Private Last War Survival alliance portal.

- **Netlify** hosts the site and the on-demand `/api` (only when someone uses the portal).
- **Supabase** (or any Postgres) holds the database.
- **GitHub Actions** sends Discord DMs ~5 minutes before a storm or calendar event.

## Local

```
npm install
npm run dev
```

Open http://127.0.0.1:8888

The first account (empty database) does not need an invite and becomes Master.
After that, registration is invite-only: generate a code in Administration and
share `/#/join?invite=CODE`.

## Environment

See `.env.example`. For local `npm run dev`, email encryption keys are generated
into `.env.local` when missing. Production on Netlify must set:

- `DATABASE_URL` — Supabase **session pooler** URI (port 5432), `sslmode=require`.
  The same value goes in the GitHub Actions secret `DATABASE_URL`.
- `EMAIL_ENCRYPTION_KEY` — 32-byte AES-256-GCM key (64 hex chars). Used to store
  member emails at rest. Never log this value.
- `EMAIL_HMAC_KEY` — separate 32-byte key for email uniqueness lookups.
- `DISCORD_BOT_TOKEN` — bot token from the Discord Developer Portal. Also set
  this as a GitHub Actions secret. No privileged intents are required. Invite
  the bot to the alliance server so Discord will allow DMs. Reminders use REST
  only (create DM channel, then send a message); there is no gateway connection.
- `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` — same application as the bot.
  These power the **Connect Discord** button on My settings. In the Discord
  portal, OAuth2 → Redirects, add both:
  `http://127.0.0.1:8888/api/auth/discord/callback`
  and
  `https://twcx-alliance-hub.netlify.app/api/auth/discord/callback`

## Production database (Supabase)

1. Create a Supabase project.
2. Copy the **Session pooler** connection string (not the transaction pooler).
3. Apply schema: `DATABASE_URL="postgresql://..." npm run migrate`
4. If you still have a dump from the old Netlify database, restore it after
   migrate, or restore first and skip migrations that already exist.
5. Set `DATABASE_URL` on the Netlify site **and** as the GitHub repo secret
   `DATABASE_URL`. Then disable the Netlify Database addon so it no longer
   consumes credits.

## Discord reminders

DMs go out **once, about five minutes before that event starts**:
- Storms: signed-up players with Discord connected
- Calendar events: members who turned on Remind me, with Discord connected

Any weekday is covered. Locally the hub sleeps until T-5. In production GitHub
Actions runs **once an hour**; if the next event is more than ~70 minutes away
it exits immediately. If it is closer, it sleeps until T-5 then sends.
Manual run: Actions → Discord reminders → Run workflow.

GitHub secrets:

- `DATABASE_URL`
- `DISCORD_BOT_TOKEN`
