import pg from "pg";

/**
 * The subset of a pooled client this app uses.
 */
export type TxClient = {
  query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

let pool: pg.Pool | null = null;

function connectionString() {
  return String(
    process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "",
  ).trim();
}

function sslFor(url: string): boolean | { rejectUnauthorized: boolean } | undefined {
  if (process.env.DATABASE_SSL === "0") return false;
  if (process.env.DATABASE_SSL === "1") return { rejectUnauthorized: false };
  if (/supabase|sslmode=require/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

/**
 * Local `npm run dev` sets NETLIFY_DB_URL to the embedded Postgres.
 * Production uses DATABASE_URL (Supabase session pooler).
 */
function database() {
  if (!pool) {
    const url = connectionString();
    if (!url) {
      throw new Error("DATABASE_URL is not set.");
    }
    pool = new pg.Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: Number(process.env.DATABASE_POOL_MAX || 4),
    });
  }
  return pool;
}

/** Runs a parameterised query and returns the rows. */
export async function query<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> {
  const result = await database().query(sql, values);
  return result.rows as T[];
}

/** Runs a query expected to return at most one row. */
export async function queryOne<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, values);
  return rows[0] ?? null;
}

/** Runs `work` inside a transaction, rolling back on any error. */
export async function transaction<T>(work: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client as unknown as TxClient);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end().catch(() => {});
}
