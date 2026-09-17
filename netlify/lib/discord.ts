/**
 * Discord REST DMs and OAuth2 account linking.
 * No gateway, no privileged intents — the bot only needs to share a server
 * with the member so Discord will open a DM channel.
 */

import { randomBytes } from "node:crypto";
import { HttpError } from "./http.js";

const API = "https://discord.com/api/v10";
const OAUTH_COOKIE = "twcx_discord_oauth";

function clientId() {
  return String(process.env.DISCORD_CLIENT_ID ?? "").trim();
}

function clientSecret() {
  return String(process.env.DISCORD_CLIENT_SECRET ?? "").trim();
}

export function discordOAuthConfigured() {
  return Boolean(clientId() && clientSecret());
}

export function discordRedirectUri(req: Request) {
  const configured = String(process.env.DISCORD_REDIRECT_ORIGIN ?? "").trim().replace(/\/+$/, "");
  const origin = configured || new URL(req.url).origin;
  return `${origin}/api/auth/discord/callback`;
}

function oauthCookieHeader(value: string, maxAgeSeconds: number) {
  const attributes = [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  const local = process.env.TWCX_LOCAL === "1" || process.env.NETLIFY_DEV === "true";
  if (!local) attributes.splice(4, 0, "Secure");
  return attributes.join("; ");
}

function readOauthCookie(req: Request) {
  const header = req.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OAUTH_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function discordAuthorizeRedirect(req: Request) {
  if (!discordOAuthConfigured()) {
    throw new HttpError("Discord connect is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.", 503);
  }
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    scope: "identify",
    redirect_uri: discordRedirectUri(req),
    state,
    prompt: "consent",
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://discord.com/oauth2/authorize?${params}`,
      "set-cookie": oauthCookieHeader(state, 600),
    },
  });
}

export async function finishDiscordOAuth(req: Request, url: URL) {
  const expected = readOauthCookie(req);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  const clear = { "set-cookie": oauthCookieHeader("", 0) };

  if (denied === "access_denied") {
    return { ok: false as const, reason: "denied", headers: clear };
  }
  if (!code || !expected || state !== expected) {
    return { ok: false as const, reason: "error", headers: clear };
  }

  const tokenRes = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "authorization_code",
      code,
      redirect_uri: discordRedirectUri(req),
    }),
  });
  if (!tokenRes.ok) return { ok: false as const, reason: "error", headers: clear };
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return { ok: false as const, reason: "error", headers: clear };

  const meRes = await fetch(`${API}/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return { ok: false as const, reason: "error", headers: clear };
  const me = (await meRes.json()) as { id?: string; username?: string; global_name?: string | null };
  if (!me.id) return { ok: false as const, reason: "error", headers: clear };

  return {
    ok: true as const,
    discordId: me.id,
    discordUsername: String(me.global_name || me.username || "").slice(0, 80),
    headers: clear,
  };
}

export function profileRedirect(req: Request, result: "connected" | "denied" | "error" | "signin") {
  const origin = String(process.env.DISCORD_REDIRECT_ORIGIN ?? "").trim().replace(/\/+$/, "") || new URL(req.url).origin;
  return `${origin}/#/profile?discord=${result}`;
}

export async function sendDiscordDM(discordUserId: string, message: string): Promise<boolean> {
  const token = String(process.env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token || !discordUserId) return false;

  try {
    const channelRes = await fetch(`${API}/users/@me/channels`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });

    if (channelRes.status === 403 || channelRes.status === 404) {
      console.warn(`discord dm skipped for ${discordUserId}: ${channelRes.status}`);
      return false;
    }
    if (channelRes.status >= 500) throw new Error(`discord channel ${channelRes.status}`);
    if (!channelRes.ok) {
      console.warn(`discord dm skipped for ${discordUserId}: ${channelRes.status}`);
      return false;
    }

    const channel = (await channelRes.json()) as { id?: string };
    if (!channel.id) return false;

    const messageRes = await fetch(`${API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: message }),
    });

    if (messageRes.status === 403 || messageRes.status === 404) {
      console.warn(`discord dm blocked for ${discordUserId}`);
      return false;
    }
    if (messageRes.status >= 500) throw new Error(`discord message ${messageRes.status}`);
    if (!messageRes.ok) {
      console.warn(`discord dm skipped for ${discordUserId}: ${messageRes.status}`);
      return false;
    }
    return true;
  } catch (error) {
    const unexpected = error instanceof Error ? error.message : "unknown";
    if (/discord (channel|message) 5\d\d/.test(unexpected) || /fetch|network|ECONN|ETIMEDOUT/i.test(unexpected)) {
      throw error;
    }
    console.warn(`discord dm failed for ${discordUserId}: ${unexpected}`);
    return false;
  }
}
