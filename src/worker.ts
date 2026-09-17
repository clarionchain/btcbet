import { tick } from "./lib/engine";
import { CoinbasePriceFeed } from "./lib/feed";
import { config } from "./lib/config";
import { pool, log } from "./lib/db";
const leader = await pool.connect();
if (
  !(await leader.query("SELECT pg_try_advisory_lock(7285302) AS held")).rows[0]
    .held
) {
  log("worker_already_running");
  process.exit(1);
}
const feed =
  config.PRICE_PROVIDER === "coinbase" ? new CoinbasePriceFeed() : null;
feed?.start();
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});
while (!stop) {
  try {
    await tick();
  } catch {
    log("worker_tick_failed");
  }
  await new Promise((r) => setTimeout(r, 1000));
}
feed?.stop();
await leader.query("SELECT pg_advisory_unlock(7285302)");
leader.release();
await pool.end();
