import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MockArkPaymentAdapter } from "../src/lib/ark";
import { pool, tx } from "../src/lib/db";
import { ensureRound } from "../src/lib/engine";
import { boundary } from "../src/lib/math";
import {
  authenticateHuman,
  confirmHumanBet,
  createHuman,
  createHumanBet,
  humanBetQr,
  humanCookie,
  humanMe,
  recoverHuman,
} from "../src/lib/human";

beforeAll(() => {
  if (!process.env.DATABASE_URL?.endsWith("/btcbet_test"))
    throw Error("Requires isolated test database");
});
afterAll(() => pool.end());
const adapter = new MockArkPaymentAdapter();
const origin = "https://clarionlab.dev";
let roundCounter = 500;
async function isolatedRound() {
  const start = new Date(boundary(Date.now()) - roundCounter++ * 300_000);
  return {
    id: await tx((db) => ensureRound(db, start)),
    start,
  };
}

async function player() {
  const returnAddress = `mock-signet:${randomUUID()}`;
  const created = await createHuman(
    { name: "Human Satoshi", returnAddress },
    adapter,
  );
  const request = new Request(origin, {
    headers: { cookie: humanCookie(created.token).split(";")[0] },
  });
  return { ...created, request, returnAddress };
}

it("creates a recoverable human session without exposing its token in storage", async () => {
  const p = await player();
  const authenticated = await authenticateHuman(p.request);
  expect(authenticated?.agent_id).toBe(p.profile.id);
  expect((await recoverHuman(p.token)).profile).toEqual(p.profile);
  const session = (
    await pool.query(
      "SELECT token_hash FROM human_sessions WHERE agent_id=$1",
      [p.profile.id],
    )
  ).rows[0];
  expect(session.token_hash).not.toBe(p.token);
  await expect(
    authenticateHuman(
      new Request(origin, { headers: { cookie: "btcbet_human=btch_bad" } }),
    ),
  ).rejects.toThrow("session");
});

it("uses one human payment to fund a bet and safely polls it more than once", async () => {
  const p = await player();
  const round = await isolatedRound();
  const roundId = round.id;
  const wager = await createHumanBet(
    p.profile.id,
    {
      roundId,
      direction: "DOWN",
      amountSats: 1000,
      idempotencyKey: randomUUID(),
    },
    adapter,
    new Date(+round.start + 10_000),
  );
  expect(wager.status).toBe("PAYMENT_REQUIRED");
  expect(
    (await confirmHumanBet(p.profile.id, wager.betId, adapter)).httpStatus,
  ).toBe(402);
  await pool.query(
    "INSERT INTO mock_receipts(id,reference,amount,received_at) VALUES($1,$2,$3,$4)",
    [
      randomUUID(),
      wager.betId,
      1000,
      new Date(+round.start + 20_000),
    ],
  );
  const accepted = await confirmHumanBet(p.profile.id, wager.betId, adapter);
  expect(accepted.httpStatus).toBe(200);
  expect(accepted.body).toMatchObject({ status: "ACCEPTED", accepted: true });
  expect(
    (await confirmHumanBet(p.profile.id, wager.betId, adapter)).body.status,
  ).toBe("ACCEPTED");
  expect((await humanMe(p.profile.id)).bets[0].status).toBe("ACCEPTED");
  expect(await humanBetQr(p.profile.id, wager.betId)).toContain("<svg");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM incoming_payments WHERE bet_id=$1",
        [wager.betId],
      )
    ).rows[0].count,
  ).toBe(1);
});

it("does not expose one human player’s bet to another session", async () => {
  const a = await player();
  const b = await player();
  const round = await isolatedRound();
  const roundId = round.id;
  const wager = await createHumanBet(
    a.profile.id,
    {
      roundId,
      direction: "UP",
      amountSats: 1000,
      idempotencyKey: randomUUID(),
    },
    adapter,
    new Date(+round.start + 10_000),
  );
  await expect(humanBetQr(b.profile.id, wager.betId)).rejects.toThrow(
    "not found",
  );
  await expect(
    confirmHumanBet(b.profile.id, wager.betId, adapter),
  ).rejects.toThrow("not found");
});
