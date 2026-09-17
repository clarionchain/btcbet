import {
  createPublicKey,
  verify,
  randomUUID,
  randomBytes,
  createHmac,
} from "node:crypto";
import { z } from "zod";
import { pool, tx, event } from "./db";
import { config } from "./config";
import { ark, type ArkPaymentAdapter } from "./ark";
import { ApiError, createIntent, receivePayment } from "./engine";
import { getBet } from "./read";
const key = z.string().regex(/^[0-9a-f]{64}$/);
export const paymentProposal = z
  .object({
    agentPublicKey: key,
    name: z.string().min(1).max(60),
    roundId: z.string().regex(/^\d{10}$/),
    direction: z.enum(["UP", "DOWN"]),
    amountSats: z.number().int().positive().max(100000000),
    returnAddress: z.string().min(3).max(500),
    idempotencyKey: z.string().min(8).max(120),
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();
export type Proposal = z.infer<typeof paymentProposal>;
export function proposalMessage(p: Omit<Proposal, "signature">) {
  return JSON.stringify([
    "btcbet:proposal:v1",
    config.PUBLIC_APP_URL,
    p.agentPublicKey,
    p.name,
    p.roundId,
    p.direction,
    p.amountSats,
    p.returnAddress,
    p.idempotencyKey,
  ]);
}
export function validSignature(
  publicKey: string,
  message: string,
  signature: string,
) {
  try {
    return verify(
      null,
      Buffer.from(message, "utf8"),
      createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(publicKey, "hex").toString("base64url"),
        },
        format: "jwk",
      }),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
const hashToken = (token: string) =>
  createHmac("sha256", config.AGENT_TOKEN_PEPPER).update(token).digest("hex");
export async function limitPaymentAuth(bucket: string, max = 20) {
  const n = (
    await pool.query(
      `INSERT INTO payment_auth_rates(key,window_at,count) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN payment_auth_rates.window_at<now()-interval '1 minute' THEN 1 ELSE payment_auth_rates.count+1 END,window_at=CASE WHEN payment_auth_rates.window_at<now()-interval '1 minute' THEN now() ELSE payment_auth_rates.window_at END RETURNING count`,
      [bucket],
    )
  ).rows[0].count;
  if (n > max)
    throw new ApiError(429, "Payment authentication rate limit reached");
}
export async function requestPayment(
  p: Proposal,
  adapter: ArkPaymentAdapter = ark,
  clock?: Date,
) {
  if (!validSignature(p.agentPublicKey, proposalMessage(p), p.signature))
    throw new ApiError(401, "Invalid agent identity signature");
  await limitPaymentAuth(`key:${p.agentPublicKey}`);
  if (!(await adapter.validateDestination(p.returnAddress)))
    throw new ApiError(400, "Invalid Ark return address");
  const a = await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      p.agentPublicKey,
    ]);
    let agent = (
      await db.query("SELECT * FROM agents WHERE identity_key=$1", [
        p.agentPublicKey,
      ])
    ).rows[0];
    if (!agent) {
      const id = randomUUID();
      agent = (
        await db.query(
          "INSERT INTO agents(id,name,identity_key,token_hash,return_address) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            id,
            p.name,
            p.agentPublicKey,
            hashToken(randomBytes(32).toString("hex")),
            p.returnAddress,
          ],
        )
      ).rows[0];
      await event(db, "agent_identity_proposed", null, { agentId: id });
    }
    if (!agent.enabled) throw new ApiError(401, "Agent disabled");
    return agent;
  });
  const intent = await createIntent(a.id, p, adapter, clock);
  const challenge = await tx(async (db) => {
    await db.query("SELECT id FROM bets WHERE id=$1 FOR UPDATE", [
      intent.betId,
    ]);
    const existing = (
      await db.query("SELECT * FROM payment_challenges WHERE bet_id=$1", [
        intent.betId,
      ])
    ).rows[0];
    if (existing) return existing;
    const id = randomUUID();
    const message = JSON.stringify([
      "btcbet:confirm:v1",
      config.PUBLIC_APP_URL,
      id,
      p.agentPublicKey,
      intent.betId,
      p.roundId,
      p.direction,
      p.amountSats,
      p.returnAddress,
      intent.paymentRequest,
      new Date(intent.lockTimestamp).toISOString(),
    ]);
    const result = (
      await db.query(
        "INSERT INTO payment_challenges(id,agent_id,bet_id,message,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [id, a.id, intent.betId, message, intent.lockTimestamp],
      )
    ).rows[0];
    await event(db, "payment_challenge_issued", p.roundId, {
      challengeId: id,
      betId: intent.betId,
    });
    return result;
  });
  return {
    protocol: "btcbet-ark402-v1",
    status: "PAYMENT_REQUIRED",
    mode: config.ARK_ADAPTER,
    network: "signet",
    arkServer: config.ARK_SERVER_URL,
    agentId: a.id,
    challengeId: challenge.id,
    challenge: challenge.message,
    betId: intent.betId,
    payment: {
      destination: intent.paymentRequest,
      amountSats: intent.amountSats,
      expiresAt: intent.lockTimestamp,
    },
    confirmUrl: `${config.PUBLIC_APP_URL}/api/v1/payment-auth/confirm`,
    keelUrl: config.KEEL_APP_URL,
    message:
      "Pay once using Keel, then sign the exact challenge with your agent identity key. A payment reference alone does not authenticate you.",
  };
}
export const confirmation = z
  .object({
    challengeId: z.uuid(),
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();
export async function confirmPayment(
  id: string,
  signature: string,
  adapter: ArkPaymentAdapter = ark,
) {
  const c = (
    await pool.query(
      "SELECT c.*,a.identity_key,a.enabled,b.receive_reference,coalesce(r.rules->>'paymentAdapter','mock') AS payment_mode FROM payment_challenges c JOIN agents a ON a.id=c.agent_id JOIN bets b ON b.id=c.bet_id JOIN rounds r ON r.id=b.round_id WHERE c.id=$1",
      [id],
    )
  ).rows[0];
  if (!c || !c.enabled || !validSignature(c.identity_key, c.message, signature))
    throw new ApiError(401, "Invalid payment challenge proof");
  if (c.payment_mode !== config.ARK_ADAPTER)
    throw new ApiError(409, "Challenge belongs to a different payment mode");
  // Only wallet-observed receipts can activate authentication. Never accept client transaction claims.
  for (const payment of await adapter.lookupIncomingPayment(
    c.receive_reference,
  ))
    await receivePayment(c.bet_id, payment);
  const bet = await getBet(c.bet_id, c.agent_id);
  if (!bet.accepted_at)
    return {
      httpStatus: bet.status === "AWAITING_PAYMENT" ? 402 : 409,
      body: {
        status: "NOT_AUTHENTICATED",
        betId: c.bet_id,
        betStatus: bet.status,
        message:
          "No eligible payment verified. Do not resend a payment already sent; poll again.",
      },
    };
  const token = createHmac("sha256", config.AGENT_TOKEN_PEPPER)
    .update(`btcbet:paid-session:v1:${id}`)
    .digest("base64url");
  const session = await tx(async (db) => {
    const agent = (
      await db.query("SELECT enabled FROM agents WHERE id=$1 FOR UPDATE", [
        c.agent_id,
      ])
    ).rows[0];
    if (!agent?.enabled) throw new ApiError(401, "Agent disabled");
    await db.query(
      "UPDATE agents SET payment_authenticated_at=coalesce(payment_authenticated_at,now()) WHERE id=$1",
      [c.agent_id],
    );
    const updated = await db.query(
      "UPDATE payment_challenges SET authenticated_at=now() WHERE id=$1 AND authenticated_at IS NULL",
      [id],
    );
    await db.query(
      "INSERT INTO payment_sessions(challenge_id,agent_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') ON CONFLICT DO NOTHING",
      [id, c.agent_id, hashToken(token)],
    );
    const row = (
      await db.query(
        "SELECT expires_at,revoked FROM payment_sessions WHERE challenge_id=$1",
        [id],
      )
    ).rows[0];
    if (row.revoked || +row.expires_at <= Date.now())
      throw new ApiError(
        401,
        "Payment session expired or revoked; authenticate with another paid bet",
      );
    if (updated.rowCount)
      await event(db, "agent_authenticated_by_payment", bet.round_id, {
        agentId: c.agent_id,
        betId: c.bet_id,
        challengeId: id,
      });
    return row;
  });
  return {
    httpStatus: 200,
    body: {
      status: "AUTHENTICATED",
      agentId: c.agent_id,
      betId: c.bet_id,
      betStatus: bet.status,
      accessToken: token,
      tokenType: "Bearer",
      expiresAt: session.expires_at,
      mode: config.ARK_ADAPTER,
    },
  };
}
export function authInstructions() {
  return {
    protocol: "btcbet-ark402-v1",
    mode: config.ARK_ADAPTER,
    network: "signet",
    arkServer: config.ARK_SERVER_URL,
    keelUrl: config.KEEL_APP_URL,
    documentation: `${config.PUBLIC_APP_URL}/agents.md`,
    challengeEndpoint: `${config.PUBLIC_APP_URL}/api/v1/payment-auth/challenge`,
    confirmationEndpoint: `${config.PUBLIC_APP_URL}/api/v1/payment-auth/confirm`,
    identity:
      "Agent-generated Ed25519 key pair; not wallet private keys. No pre-issued API key.",
    session:
      "24-hour bearer session issued only after an accepted payment. Every wager still requires its own payment.",
    payment:
      "Ordinary Second Ark transfer from Keel to the unique challenge destination. Sign and submit the exact confirmation challenge; never send a second payment just because HTTP retries.",
    compatibleWithX402: false,
  };
}
