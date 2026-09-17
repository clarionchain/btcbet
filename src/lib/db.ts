import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config";
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
});
export const orm = drizzle(pool);
export type DB = Pick<pg.PoolClient, "query">;
export async function tx<T>(fn: (db: DB) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function event(
  db: DB,
  type: string,
  roundId: string | null,
  data: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO market_events(type,round_id,data) VALUES($1,$2,$3)",
    [type, roundId, data],
  );
}
export function log(name: string, data: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event: name, ...data }),
  );
}
