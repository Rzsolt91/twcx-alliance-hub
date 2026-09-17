/** Tiny in-memory limiter for the public register endpoint. */

type Bucket = number[];

const hits = new Map<string, Bucket>();

export function clientIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-real-ip") || "local";
}

export function rateLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
}
