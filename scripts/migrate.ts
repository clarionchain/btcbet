import { readFile } from "node:fs/promises";
import { tx, pool } from "../src/lib/db";
await tx(async (db) => {
  await db.query("SELECT pg_advisory_xact_lock(7285300)");
  await db.query(
    "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
  );
  for (const name of [
    "001_ledger",
    "002_payment_auth",
    "003_payment_modes",
    "004_human_players",
  ]) {
    if (
      !(await db.query("SELECT 1 FROM migrations WHERE name=$1", [name]))
        .rowCount
    ) {
      await db.query(await readFile(`migrations/${name}.sql`, "utf8"));
      await db.query("INSERT INTO migrations(name) VALUES($1)", [name]);
    }
  }
});
await pool.end();
console.log("Migrations current");
