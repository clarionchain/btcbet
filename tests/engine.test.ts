import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, tx } from "../src/lib/db";
import { boundary } from "../src/lib/math";
import {
  ensureRound,
  createIntent,
  receivePayment,
  settle,
  payOutgoing,
  reconcile,
  tick,
} from "../src/lib/engine";
import { MockArkPaymentAdapter } from "../src/lib/ark";
import { tokenHash } from "../src/lib/auth";
// This suite is restricted to a dedicated test database; never truncate the production ledger.
beforeAll(() => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith("/btcbet_test"))
    throw Error("Use btcbet_test database");
});
afterAll(async () => {
  await pool.end();
});
const mock = new MockArkPaymentAdapter();
let index = 0;
async function fixture() {
  const now = new Date(boundary(Date.now()) - ++index * 300000),
    id = String(+now / 1000);
  await tx((db) => ensureRound(db, now));
  const a = randomUUID(),
    b = randomUUID();
  for (const x of [a, b])
    await pool.query(
      "INSERT INTO agents(id,name,token_hash,return_address) VALUES($1,$2,$3,$4)",
      [x, `Test ${x.slice(0, 4)}`, tokenHash(x), `mock-signet:${x}`],
    );
  return {
    id,
    a,
    b,
    start: now,
    lock: new Date(+now + 285000),
    end: new Date(+now + 300000),
  };
}
async function bet(
  f: any,
  agent: string,
  direction: "UP" | "DOWN" = "UP",
  key = randomUUID(),
) {
  return createIntent(
    agent,
    {
      roundId: f.id,
      direction,
      amountSats: 1000,
      returnAddress: `mock-signet:${agent}`,
      idempotencyKey: key,
    },
    mock,
    new Date(+f.start + 10000),
  );
}
async function pay(
  f: any,
  b: any,
  at?: Date,
  amount = "1000",
  id = randomUUID(),
) {
  await receivePayment(b.betId, {
    id,
    amount,
    receivedAt: (at ?? new Date(+f.start + 20000)).toISOString(),
  });
  return id;
}
async function prices(f: any) {
  for (const [offset, price] of [
    [1000, "100"],
    [2000, "101"],
    [3000, "102"],
    [296000, "103"],
    [297000, "104"],
    [298000, "105"],
  ] as const)
    await pool.query(
      "INSERT INTO price_observations(provider,pair,provider_at,received_at,price,sequence,payload) VALUES($1,$2,$3,$3,$4,$5,$6)",
      [
        "coinbase",
        "BTC-USD",
        new Date(+f.start + offset),
        price,
        `${f.id}:${offset}`,
        {},
      ],
    );
}
const status = async (id: string) =>
  (await pool.query("SELECT status FROM bets WHERE id=$1", [id])).rows[0]
    .status;
describe.sequential("PostgreSQL payment and settlement recovery", () => {
  it("creates, pays and returns original idempotent response; rejects changed data", async () => {
    const f = await fixture(),
      key = randomUUID(),
      b = await bet(f, f.a, "UP", key);
    expect(await bet(f, f.a, "UP", key)).toEqual(JSON.parse(JSON.stringify(b)));
    await expect(bet(f, f.a, "DOWN", key)).rejects.toThrow("different data");
    await pay(f, b);
    expect(await status(b.betId)).toBe("ACCEPTED");
  });
  it("serializes concurrent duplicate intents and acceptance", async () => {
    const f = await fixture(),
      key = randomUUID();
    const [a, b] = await Promise.all([
      bet(f, f.a, "UP", key),
      bet(f, f.a, "UP", key),
    ]);
    expect(a.betId).toBe(b.betId);
    const second = await bet(f, f.a, "DOWN");
    await Promise.all([pay(f, a), pay(f, second)]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM bets WHERE agent_id=$1 AND accepted_at IS NOT NULL",
          [f.a],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("deduplicates receipt and refunds additional payment", async () => {
    const f = await fixture(),
      b = await bet(f, f.a),
      id = await pay(f, b);
    await pay(f, b, undefined, "1000", id);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM incoming_payments WHERE bet_id=$1",
          [b.betId],
        )
      ).rows[0].n,
    ).toBe(1);
    await pay(f, b);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM settlement_obligations WHERE bet_id=$1",
          [b.betId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("accepts just before cutoff, refunds exactly at cutoff and mismatch amounts", async () => {
    const f = await fixture(),
      a = await bet(f, f.a),
      b = await bet(f, f.b);
    await pay(f, a, new Date(+f.lock - 1));
    await pay(f, b, f.lock);
    expect(await status(a.betId)).toBe("ACCEPTED");
    expect(await status(b.betId)).toBe("REFUND_PENDING");
    const g = await fixture(),
      c = await bet(g, g.a);
    await pay(g, c, undefined, "999");
    expect(await status(c.betId)).toBe("REFUND_PENDING");
    const d = await bet(g, g.b);
    await pay(g, d, undefined, "1001");
    expect(await status(d.betId)).toBe("REFUND_PENDING");
  });
  it("voids missing observations and refunds all accepted stakes", async () => {
    const f = await fixture(),
      a = await bet(f, f.a),
      b = await bet(f, f.b, "DOWN");
    await pay(f, a);
    await pay(f, b);
    await settle(f.id, new Date(+f.end + 4000));
    await payOutgoing();
    expect(await status(a.betId)).toBe("REFUNDED");
    expect(
      (await pool.query("SELECT reason FROM rounds WHERE id=$1", [f.id]))
        .rows[0].reason,
    ).toContain("Insufficient");
  });
  it("pays winners and survives repeated resolution and payout work", async () => {
    const f = await fixture(),
      a = await bet(f, f.a),
      b = await bet(f, f.b, "DOWN");
    await prices(f);
    await pay(f, a);
    await pay(f, b);
    await settle(f.id, new Date(+f.end + 4000));
    await settle(f.id, new Date(+f.end + 5000));
    await payOutgoing();
    await payOutgoing();
    expect(await status(a.betId)).toBe("PAID_OUT");
    expect(await status(b.betId)).toBe("LOST");
    expect(
      (
        await pool.query(
          "SELECT amount::text FROM mock_sends WHERE reference=$1",
          [`settle:${a.betId}`],
        )
      ).rows[0].amount,
    ).toBe("2000");
  });
  it("refunds one-sided markets despite a valid price result", async () => {
    const f = await fixture(),
      a = await bet(f, f.a);
    await prices(f);
    await pay(f, a);
    await settle(f.id, new Date(+f.end + 4000));
    await payOutgoing();
    expect(await status(a.betId)).toBe("REFUNDED");
  });
  it("recovers provider success followed by lost acknowledgement without duplicate transfer", async () => {
    const f = await fixture(),
      a = await bet(f, f.a);
    await pay(f, a);
    await settle(f.id, new Date(+f.end + 4000));
    class Ambiguous extends MockArkPaymentAdapter {
      async sendPayment(i: any): Promise<never> {
        await super.sendPayment(i);
        throw Error("Connection lost after send");
      }
    }
    await payOutgoing(new Ambiguous());
    expect(await status(a.betId)).toBe("REFUND_PENDING");
    await pool.query(
      "UPDATE outgoing_payments SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [`settle:${a.betId}`],
    );
    await payOutgoing(new MockArkPaymentAdapter());
    expect(await status(a.betId)).toBe("REFUNDED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM mock_sends WHERE reference=$1",
          [`settle:${a.betId}`],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("watches expired references and refunds late transfers after settlement", async () => {
    const f = await fixture(),
      a = await bet(f, f.a);
    await settle(f.id, new Date(+f.end + 4000));
    expect(await status(a.betId)).toBe("EXPIRED");
    await pool.query(
      "INSERT INTO mock_receipts(id,reference,amount,received_at) VALUES($1,$2,1000,$3)",
      [randomUUID(), a.betId, new Date(+f.end + 10000)],
    );
    await reconcile();
    await payOutgoing();
    expect(await status(a.betId)).toBe("REFUNDED");
  });
  it("prevents audit mutation", async () => {
    await expect(
      pool.query(
        "UPDATE market_events SET type='tamper' WHERE id=(SELECT min(id) FROM market_events)",
      ),
    ).rejects.toThrow("append-only");
  });
  it("rejects disabled agents and enforces reserved daily limits", async () => {
    const f = await fixture();
    await pool.query("UPDATE agents SET daily_limit=1000 WHERE id=$1", [f.a]);
    await bet(f, f.a);
    await expect(bet(f, f.a, "DOWN")).rejects.toThrow("spending limit");
    await pool.query("UPDATE agents SET enabled=false WHERE id=$1", [f.b]);
    await expect(bet(f, f.b)).rejects.toThrow("disabled");
  });
  it("recovers persisted SENDING state with a fresh adapter instance", async () => {
    const f = await fixture(),
      a = await bet(f, f.a);
    await pay(f, a);
    await settle(f.id, new Date(+f.end + 4000));
    const id = `settle:${a.betId}`;
    await pool.query(
      "UPDATE outgoing_payments SET status='SENDING' WHERE id=$1",
      [id],
    );
    await new MockArkPaymentAdapter().sendPayment({
      reference: id,
      amount: "1000",
      destination: `mock-signet:${f.a}`,
    });
    await payOutgoing(new MockArkPaymentAdapter());
    expect(await status(a.betId)).toBe("REFUNDED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM mock_sends WHERE reference=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("recovers missing round boundaries from a persisted cursor", async () => {
    const now = new Date(boundary(Date.now()) + 900000);
    await tick(now, new MockArkPaymentAdapter());
    const cursor = (
      await pool.query(
        "SELECT value FROM system_settings WHERE key='recovery_cursor'",
      )
    ).rows[0].value;
    expect(Number(cursor)).toBe(boundary(+now) + 300000);
    await tick(new Date(+now + 600000), new MockArkPaymentAdapter());
    for (const offset of [0, 300000, 600000])
      expect(
        (
          await pool.query("SELECT 1 FROM rounds WHERE id=$1", [
            String((+now + offset) / 1000),
          ])
        ).rowCount,
      ).toBe(1);
  });
});

it("refuses new bets and outgoing transfers for a different payment mode", async () => {
  const f = await fixture();
  const a = await bet(f, f.a);
  await pay(f, a);
  await settle(f.id, new Date(+f.end + 4000));
  await pool.query(`UPDATE rounds SET rules=rules || '{"paymentAdapter":"second"}'::jsonb WHERE id=$1`, [f.id]);
  await payOutgoing();
  expect(await status(a.betId)).toBe("REFUND_PENDING");
  const fresh = await fixture();
  await pool.query(`UPDATE rounds SET rules=rules || '{"paymentAdapter":"second"}'::jsonb WHERE id=$1`, [fresh.id]);
  await expect(bet(fresh,fresh.a)).rejects.toThrow("Payment mode changed");
});
