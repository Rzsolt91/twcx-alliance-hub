import type { UserSignupEvent } from "@netlify/functions";
import { transaction } from "../lib/db.js";
import { emailColumns } from "../lib/emails.js";

/**
 * Identity signup trigger: create (or link) the portal account as the Identity
 * user is created. Invite-only registration creates the Identity user via the
 * Admin API first; walk-in Identity signups without an invite do not get a
 * portal row (see currentAccount).
 */
export default {
  async userSignup(event: UserSignupEvent) {
    const identityId = event.user.id;
    const email = String(event.user.email ?? "").trim().toLowerCase();
    const invited = Boolean(
      (event.user.userMetadata as { invite_code?: string } | undefined)?.invite_code ||
        (event.user.appMetadata as { invite?: boolean } | undefined)?.invite,
    );
    const requested =
      String(event.user.userMetadata?.full_name ?? email.split("@")[0] ?? "Player").trim().slice(0, 30) || "Player";

    const packed = email ? emailColumns(email) : emailColumns(null);
    const lookup = packed.email_lookup_hash;

    const role = await transaction(async (client) => {
      await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");

      const existing = await client.query<{ role: string }>("SELECT role FROM users WHERE identity_id = $1", [
        identityId,
      ]);
      if (existing.rows[0]) return existing.rows[0].role;

      if (lookup) {
        const byEmail = await client.query<{ id: number; role: string }>(
          "SELECT id, role FROM users WHERE email_lookup_hash = $1",
          [lookup],
        );
        if (byEmail.rows[0]) {
          await client.query("UPDATE users SET identity_id = $1 WHERE id = $2 AND identity_id IS NULL", [
            identityId,
            byEmail.rows[0].id,
          ]);
          return byEmail.rows[0].role;
        }
      }

      const isFirst = (await client.query("SELECT NOT EXISTS (SELECT 1 FROM users) AS first")).rows[0].first;
      if (!isFirst && !invited) {
        // Public Identity signup without an invite: no portal account.
        return "R3";
      }

      const taken = requested
        ? (
            await client.query("SELECT EXISTS (SELECT 1 FROM users WHERE lower(player_name) = lower($1)) AS taken", [
              requested,
            ])
          ).rows[0].taken
        : true;
      const playerName = isFirst ? (taken ? `${requested.slice(0, 21)}-${identityId.slice(0, 8)}` : requested) : null;
      const assigned = isFirst ? "MASTER" : "R3";

      const nameFree =
        playerName &&
        !(
          await client.query("SELECT EXISTS (SELECT 1 FROM users WHERE login_name = $1) AS taken", [
            playerName.toLowerCase(),
          ])
        ).rows[0].taken;

      await client.query(
        `INSERT INTO users (
           email, email_encrypted, email_lookup_hash, player_name, login_name, identity_id, role, onboarding_complete
         ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
        [
          packed.email_encrypted,
          packed.email_lookup_hash,
          playerName,
          nameFree && playerName ? playerName.toLowerCase() : null,
          identityId,
          assigned,
          false,
        ],
      );
      return assigned;
    });

    return {
      user: {
        ...event.user,
        appMetadata: {
          ...event.user.appMetadata,
          roles: [role.toLowerCase()],
        },
      },
    };
  },
};
