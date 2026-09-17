import { getDatabase } from "@netlify/database";

/**
 * The subset of a pooled client this app uses. Netlify Database hands back
 * either a `pg` or a Neon serverless client depending on the runtime, and both
 * satisfy this shape.
 */
export type TxClient = {
  query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

let cached: ReturnType<typeof getDatabase> | null = null;

/** Local `npm run dev` sets NETLIFY_DB_URL; production uses Netlify's provisioned DB. */
function database() {
  if (!cached) {
    const connectionString = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL;
    cached = connectionString ? getDatabase({ connectionString }) : getDatabase();
  }
  return cached;
}

/** Runs a parameterised query and returns the rows. */
export async function query<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> {
  const result = await database().pool.query(sql, values);
  return result.rows as T[];
}

/** Runs a query expected to return at most one row. */
export async function queryOne<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, values);
  return rows[0] ?? null;
}

/** Runs `work` inside a transaction, rolling back on any error. */
export async function transaction<T>(work: (client: TxClient) => Promise<T>): Promise<T> {
  const client = (await database().pool.connect()) as unknown as TxClient;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
