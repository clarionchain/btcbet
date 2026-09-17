import { beforeAll, afterAll, it, expect } from "vitest";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { pool, tx } from "../src/lib/db";
import { boundary } from "../src/lib/math";
import { ensureRound } from "../src/lib/engine";
import { MockArkPaymentAdapter } from "../src/lib/ark";
import {
  requestPayment,
  confirmPayment,
  proposalMessage,
} from "../src/lib/payment-auth";
import { authenticate, tokenHash } from "../src/lib/auth";
import {
  SecondArkPaymentAdapter,
  incomingFor,
  recoverSend,
} from "../src/lib/second-ark";
beforeAll(() => {
  if (!process.env.DATABASE_URL?.endsWith("/btcbet_test"))
    throw Error("Requires isolated test database");
});
afterAll(() => pool.end());
let counter = 100;
const adapter = new MockArkPaymentAdapter();
async function fixture() {
  const start = new Date(boundary(Date.now()) - counter++ * 300000),
    roundId = await tx((db) => ensureRound(db, start));
  const keys = generateKeyPairSync("ed25519"),
    agentPublicKey = Buffer.from(
      keys.publicKey.export({ format: "jwk" }).x!,
      "base64url",
    ).toString("hex");
  const proposal = {
    agentPublicKey,
    name: "Payment agent",
    roundId,
    direction: "UP" as const,
    amountSats: 1000,
    returnAddress: `mock-signet:${randomUUID()}`,
    idempotencyKey: randomUUID(),
  };
  const signature = sign(
    null,
    Buffer.from(proposalMessage(proposal)),
    keys.privateKey,
  ).toString("hex");
  const challenge = await requestPayment(
    { ...proposal, signature },
    adapter,
    new Date(+start + 10000),
  );
  const proof = sign(
    null,
    Buffer.from(challenge.challenge),
    keys.privateKey,
  ).toString("hex");
  return { start, keys, proposal, signature, challenge, proof };
}
async function fund(
  f: Awaited<ReturnType<typeof fixture>>,
  amount = 1000,
  offset = 20000,
) {
  await pool.query(
    "INSERT INTO mock_receipts(id,reference,amount,received_at) VALUES($1,$2,$3,$4)",
    [randomUUID(), f.challenge.betId, amount, new Date(+f.start + offset)],
  );
}
it("does not authenticate a correctly signed but unpaid challenge", async () => {
  const f = await fixture();
  const r = await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  expect(r.httpStatus).toBe(402);
  expect("accessToken" in r.body).toBe(false);
  expect(
    (
      await pool.query("SELECT 1 FROM payment_sessions WHERE agent_id=$1", [
        f.challenge.agentId,
      ])
    ).rowCount,
  ).toBe(0);
});
it("authenticates only after wallet receipt and stores only a token hash", async () => {
  const f = await fixture();
  await fund(f);
  const r = await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  expect(r.httpStatus).toBe(200);
  const token = (r.body as any).accessToken;
  expect(
    await authenticate(
      new Request("https://example.test", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      true,
    ),
  ).toBe(f.challenge.agentId);
  const row = (
    await pool.query(
      "SELECT token_hash FROM payment_sessions WHERE challenge_id=$1",
      [f.challenge.challengeId],
    )
  ).rows[0];
  expect(row.token_hash).toBe(tokenHash(token));
  expect(row.token_hash).not.toBe(token);
});
it("rejects a thief who knows the challenge and receipt but has another key", async () => {
  const f = await fixture();
  await fund(f);
  const thief = generateKeyPairSync("ed25519");
  const signature = sign(
    null,
    Buffer.from(f.challenge.challenge),
    thief.privateKey,
  ).toString("hex");
  await expect(
    confirmPayment(f.challenge.challengeId, signature, adapter),
  ).rejects.toThrow("Invalid");
});
it("rejects tampered bet directions and return addresses", async () => {
  const f = await fixture();
  await expect(
    requestPayment(
      { ...f.proposal, direction: "DOWN", signature: f.signature },
      adapter,
    ),
  ).rejects.toThrow("Invalid");
  await expect(
    requestPayment(
      {
        ...f.proposal,
        returnAddress: "mock-signet:thief",
        signature: f.signature,
      },
      adapter,
    ),
  ).rejects.toThrow("Invalid");
});
it("replays the same challenge and payment without duplicate acceptance/session", async () => {
  const f = await fixture();
  const again = await requestPayment(
    { ...f.proposal, signature: f.signature },
    adapter,
    new Date(+f.start + 10000),
  );
  expect(again.challengeId).toBe(f.challenge.challengeId);
  await fund(f);
  const a = await confirmPayment(f.challenge.challengeId, f.proof, adapter),
    b = await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  expect((a.body as any).accessToken).toBe((b.body as any).accessToken);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incoming_payments WHERE bet_id=$1",
        [f.challenge.betId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("refunds late payment without issuing authentication", async () => {
  const f = await fixture();
  await fund(f, 1000, 285000);
  const r = await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  expect(r.httpStatus).toBe(409);
  expect((r.body as any).betStatus).toBe("REFUND_PENDING");
  expect("accessToken" in r.body).toBe(false);
});
it("does not authenticate an underpaid request", async () => {
  const f = await fixture();
  await fund(f, 999);
  expect(
    (await confirmPayment(f.challenge.challengeId, f.proof, adapter))
      .httpStatus,
  ).toBe(409);
});
it("rejects disabled agents and revoked or expired sessions", async () => {
  const f = await fixture();
  await fund(f);
  const r = await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  const request = new Request("https://example.test", {
    headers: { Authorization: `Bearer ${(r.body as any).accessToken}` },
  });
  await pool.query(
    "UPDATE payment_sessions SET revoked=true WHERE challenge_id=$1",
    [f.challenge.challengeId],
  );
  await expect(authenticate(request, true)).rejects.toThrow("Invalid");
  await expect(
    confirmPayment(f.challenge.challengeId, f.proof, adapter),
  ).rejects.toThrow("revoked");
  await pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    f.challenge.agentId,
  ]);
  await expect(
    confirmPayment(f.challenge.challengeId, f.proof, adapter),
  ).rejects.toThrow("Invalid");
});
it("binds confirmation to its specific challenge", async () => {
  const a = await fixture(),
    b = await fixture();
  await fund(b);
  await expect(
    confirmPayment(b.challenge.challengeId, a.proof, adapter),
  ).rejects.toThrow("Invalid");
});
it("maps only successful address-matched Ark receipts using completed timestamps", () => {
  const m: any = {
    id: 1,
    status: "successful",
    time: {
      created_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:00:02Z",
    },
    received_on: [
      { destination: { type: "ark", value: "address" }, amount_sat: 1000 },
    ],
    sent_to: [],
  };
  expect(incomingFor([m], "address")[0].receivedAt).toBe(m.time.completed_at);
  expect(incomingFor([{ ...m, status: "pending" }], "address")).toEqual([]);
  expect(incomingFor([m], "other")).toEqual([]);
});
it("matches outgoing history only after the recorded baseline", () => {
  const m: any = {
    id: 12,
    status: "successful",
    sent_to: [
      { destination: { type: "ark", value: "address" }, amount_sat: 1000 },
    ],
  };
  expect(recoverSend([m], [12], "address", "1000")).toEqual([]);
  expect(recoverSend([m], [11], "address", "1000")).toEqual([m]);
  expect(recoverSend([m], [11], "address", "1001")).toEqual([]);
});
it("never resends an ambiguous real-adapter operation, and can recover subsequent evidence", async () => {
  class FakeCLI extends SecondArkPaymentAdapter {
    calls = 0;
    history: any[] = [];
    protected async cli(args: string[]) {
      if (args[0] === "history") return JSON.stringify(this.history);
      if (args[0] === "balance")
        return JSON.stringify({ spendable_sat: 10000 });
      if (args[0] === "send") {
        this.calls++;
        throw Error("Lost connection");
      }
      throw Error("Unexpected command");
    }
  }
  const a = new FakeCLI(),
    i = {
      reference: `fault-${randomUUID()}`,
      amount: "1000",
      destination: "test-ark-address",
    };
  await expect(a.sendPayment(i)).rejects.toThrow("reconciliation");
  await expect(a.sendPayment(i)).rejects.toThrow("reconciliation");
  expect(a.calls).toBe(1);
  a.history = [
    {
      id: 99,
      status: "successful",
      sent_to: [
        {
          destination: { type: "ark", value: i.destination },
          amount_sat: 1000,
        },
      ],
    },
  ];
  expect(await a.sendPayment(i)).toEqual({
    id: "second-send:99",
    confirmed: true,
  });
  expect(a.calls).toBe(1);
});

it("cannot claim authentication or replay an intent across payment modes", async () => {
  const f = await fixture();
  await fund(f);
  await confirmPayment(f.challenge.challengeId, f.proof, adapter);
  await pool.query(`UPDATE rounds SET rules=rules || '{"paymentAdapter":"second"}'::jsonb WHERE id=$1`,[f.proposal.roundId]);
  await expect(confirmPayment(f.challenge.challengeId,f.proof,adapter)).rejects.toThrow("different payment mode");
  await expect(requestPayment({...f.proposal,signature:f.signature},adapter,new Date(+f.start+10000))).rejects.toThrow("Payment mode changed");
});
