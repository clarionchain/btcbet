import { randomUUID, randomBytes } from "node:crypto";
import { pool, tx, event } from "../src/lib/db";
import { config } from "../src/lib/config";
import { tokenHash } from "../src/lib/auth";
import { ensureRound, createIntent } from "../src/lib/engine";
if (config.ARK_ADAPTER !== "mock")
  throw Error("Demo requires mock payment adapter");
const now = new Date();
const id = await tx((db) => ensureRound(db, now));
const round = (await pool.query("SELECT * FROM rounds WHERE id=$1", [id]))
  .rows[0];
if (+round.lock_at - Date.now() < 10000)
  throw Error(
    "Round is nearly locked; run after next UTC five-minute boundary",
  );
for (const [name, direction] of [
  ["Demo Atlas", "UP"],
  ["Demo Vector", "DOWN"],
] as const) {
  let a = (await pool.query("SELECT id FROM agents WHERE name=$1", [name]))
    .rows[0];
  if (!a) {
    const aid = randomUUID();
    await tx(async (db) => {
      await db.query(
        "INSERT INTO agents(id,name,token_hash,return_address,metadata) VALUES($1,$2,$3,$4,$5)",
        [
          aid,
          name,
          tokenHash(randomBytes(32).toString("base64url")),
          `mock-signet:${aid}`,
          { demo: true },
        ],
      );
      await event(db, "agent_created", null, { agentId: aid, demo: true });
    });
    a = { id: aid };
  }
  const b = await createIntent(a.id, {
    roundId: id,
    direction,
    amountSats: 1000,
    returnAddress: `mock-signet:${a.id}`,
    idempotencyKey: `demo-${id}-${direction}`,
  });
  await pool.query(
    "INSERT INTO mock_receipts(id,reference,amount,received_at) VALUES($1,$2,1000,clock_timestamp()) ON CONFLICT DO NOTHING",
    [`demo-${b.betId}`, b.betId],
  );
  console.log(
    JSON.stringify({ agent: name, roundId: id, betId: b.betId, direction }),
  );
}
console.log(
  "Worker will accept receipts and settle from live Coinbase observations. Demo agents have no issued credentials; rotate a token with admin to use one.",
);
await pool.end();
