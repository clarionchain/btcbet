import "dotenv/config";
import pg from "pg";
import { spawnSync } from "node:child_process";
const url = new URL(process.env.DATABASE_URL!);
url.pathname = "/btcbet_test";
const env = { ...process.env, DATABASE_URL: url.toString(), ARK_ADAPTER: "mock", ARK_WALLET_CONFIG: "" };
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
if (url.pathname !== "/btcbet_test") throw Error("Unsafe test database");
await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
await c.end();
for (const args of [
  ["tsx", "scripts/migrate.ts"],
  ["vitest", "run"],
]) {
  const r = spawnSync("npx", args, { env, stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
