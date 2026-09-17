import type { Config } from "@netlify/functions";
import { currentAccount, requireOnboarded } from "../lib/auth.js";
import { HttpError, fail } from "../lib/http.js";
import type { RouteContext } from "../lib/router.js";
import { matchRoute } from "../lib/router.js";
import { accountRoutes } from "../lib/routes/account.js";
import { adminRoutes } from "../lib/routes/admin.js";
import { authRoutes, publicAuthRoutes } from "../lib/routes/auth.js";
import { calendarRoutes } from "../lib/routes/calendar.js";
import { communityRoutes } from "../lib/routes/community.js";
import { eventRoutes } from "../lib/routes/events.js";
import { libraryRoutes } from "../lib/routes/library.js";
import { rosterRoutes } from "../lib/routes/roster.js";
import { vsRoutes } from "../lib/routes/vs.js";

/** Reachable without a session: registration, sign-in, sign-out, bootstrap. */
const publicRoutes = {
  ...publicAuthRoutes,
};

const routes = {
  ...accountRoutes,
  ...authRoutes,
  ...rosterRoutes,
  ...eventRoutes,
  ...calendarRoutes,
  ...vsRoutes,
  ...communityRoutes,
  ...libraryRoutes,
  ...adminRoutes,
};

/** Signed-in callers may hit these before finishing the onboarding wizard. */
const BEFORE_ONBOARDING = new Set(["GET session", "POST account/onboarding"]);

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const open = matchRoute(publicRoutes, req.method, path);
  const matched = matchRoute(routes, req.method, path);

  if (!open && !matched) {
    const known = [...Object.keys(routes), ...Object.keys(publicRoutes)];
    const pathExists = known.some((candidate) => {
      const pattern = candidate.slice(candidate.indexOf(" ") + 1);
      if (pattern === path) return true;
      if (!pattern.includes(":")) return false;
      const patternParts = pattern.split("/");
      const pathParts = path.split("/");
      if (patternParts.length !== pathParts.length) return false;
      return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
    });
    return pathExists ? fail("Method not allowed for this endpoint.", 405) : fail("Unknown endpoint.", 404);
  }

  try {
    if (open) return await open.handler({ req, url, params: open.params });

    const account = await currentAccount(req);
    if (!account) return fail("Sign in to continue.", 401);

    const key = `${req.method} ${path}`;
    if (!BEFORE_ONBOARDING.has(key) && !BEFORE_ONBOARDING.has(matched!.key)) {
      requireOnboarded(account);
    }

    const context: RouteContext = { account, req, url, params: matched!.params };
    return await matched!.handler(context);
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status);
    console.error(`api ${req.method} /${path} failed`, error);
    return fail("Something went wrong handling that request.", 500);
  }
};

export const config: Config = { path: "/api/*" };
