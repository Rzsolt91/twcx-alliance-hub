# TWCX Alliance Hub

Private Last War Survival alliance portal. Production runs on Netlify
(Functions + Postgres + Identity).

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

- `EMAIL_ENCRYPTION_KEY` — 32-byte AES-256-GCM key (64 hex chars). Used to store
  member emails at rest. Never log this value.
- `EMAIL_HMAC_KEY` — separate 32-byte key for email uniqueness lookups.
- `DISCORD_BOT_TOKEN` — bot token from the Discord Developer Portal. No privileged
  intents are required. Invite the bot to the alliance server so Discord will
  allow DMs. Reminders use REST only (create DM channel, then send a message);
  there is no gateway connection.
- `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` — same application as the bot.
  These power the **Connect Discord** button on My settings. In the Discord
  portal, OAuth2 → Redirects, add both:
  `http://127.0.0.1:8888/api/auth/discord/callback`
  and
  `https://twcx-alliance-hub.netlify.app/api/auth/discord/callback`

Discord DMs go out **once, five minutes before that event starts**, and only to
players signed up for that occurrence. Locally the hub sleeps until T-5.
On Netlify the reminder function runs every five minutes and still only sends
inside that window.
