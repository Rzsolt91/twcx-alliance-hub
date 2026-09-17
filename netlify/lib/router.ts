import type { Account } from "./auth.js";

export type RouteContext = {
  /** The signed-in account behind this request. */
  account: Account;
  req: Request;
  url: URL;
  /** Captured `:param` segments, e.g. `{ id: "12" }` for `admin/invite-codes/:id`. */
  params: Record<string, string>;
};

export type RouteHandler = (context: RouteContext) => Promise<Response>;

/** Routes keyed by `"<METHOD> <path>"`, e.g. `"GET roster"` or `"PATCH admin/invite-codes/:id"`. */
export type RouteTable = Record<string, RouteHandler>;

/** Context for the handful of endpoints reachable before signing in. */
export type PublicContext = {
  req: Request;
  url: URL;
  params: Record<string, string>;
};

export type PublicHandler = (context: PublicContext) => Promise<Response>;

/** Unauthenticated routes, keyed the same way as `RouteTable`. */
export type PublicTable = Record<string, PublicHandler>;

type Matched<T> = { handler: T; params: Record<string, string>; key: string };

/** Exact `"METHOD path"` first, then patterns that contain `:param` segments. */
export function matchRoute<T>(table: Record<string, T>, method: string, path: string): Matched<T> | null {
  const exactKey = `${method} ${path}`;
  const exact = table[exactKey];
  if (exact) return { handler: exact, params: {}, key: exactKey };

  for (const [key, handler] of Object.entries(table)) {
    const space = key.indexOf(" ");
    if (space < 0) continue;
    const verb = key.slice(0, space);
    const pattern = key.slice(space + 1);
    if (verb !== method || !pattern.includes(":")) continue;

    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternParts.length; index += 1) {
      const part = patternParts[index];
      if (part.startsWith(":") && part.length > 1) {
        params[part.slice(1)] = decodeURIComponent(pathParts[index]);
      } else if (part !== pathParts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params, key };
  }
  return null;
}
