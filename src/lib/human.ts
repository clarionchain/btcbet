import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { ark, type ArkPaymentAdapter } from "./ark";
import { tokenHash } from "./auth";
import { config } from "./config";
import { event, pool, tx } from "./db";
import { ApiError, createIntent, receivePayment } from "./engine";
import { getBet, performance } from "./read";

export const HUMAN_COOKIE = "btcbet_human";
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const tokenPattern = /^btch_[A-Za-z0-9_-]{43}$/;
export const humanProfile = z
  .object({
    name: z.string().trim().min(2).max(40),
    returnAddress: z.string().trim().min(3).max(500),
  })
  .strict();
export const humanBet = z
  .object({
    roundId: z.string().regex(/^\d{10}$/),
    direction: z.enum(["UP", "DOWN"]),
    amountSats: z.number().int().positive().max(100000000),
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict();

export function humanCookie(token: string) {
  const secure = config.PUBLIC_APP_URL.startsWith("https:") ? "; Secure" : "";
  return `${HUMAN_COOKIE}=${token}; Path=/btcbet; HttpOnly${secure}; SameSite=Lax; Max-Age=${YEAR_SECONDS}`;
}
function cookieToken(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === HUMAN_COOKIE)?.[1];
}
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(config.PUBLIC_APP_URL).origin)
    throw new ApiError(403, "Invalid request origin");
}
export async function authenticateHuman(request: Request, required = true) {
  const token = cookieToken(request);
  if (!token || !tokenPattern.test(token)) {
    if (required) throw new ApiError(401, "Human session required");
    return null;
  }
  const row = (
    await pool.query(
      `SELECT s.id,s.agent_id,a.name,a.return_address
       FROM human_sessions s JOIN agents a ON a.id=s.agent_id
       WHERE s.token_hash=$1 AND s.revoked=false AND s.expires_at>now()
         AND a.enabled=true AND a.actor_type='HUMAN'`,
      [tokenHash(token)],
    )
  ).rows[0];
  if (!row) {
    if (required) throw new ApiError(401, "Human session expired or invalid");
    return null;
  }
  await pool.query("UPDATE human_sessions SET last_seen_at=now() WHERE id=$1", [
    row.id,
  ]);
  return row as {
    id: string;
    agent_id: string;
    name: string;
    return_address: string;
  };
}
function newHumanToken() {
  return `btch_${randomBytes(32).toString("base64url")}`;
}
export async function createHuman(
  input: z.infer<typeof humanProfile>,
  adapter: ArkPaymentAdapter = ark,
) {
  if (!(await adapter.validateDestination(input.returnAddress)))
    throw new ApiError(400, "Invalid Keel signet return address");
  if (!(await adapter.getWalletStatus()).ready)
    throw new ApiError(503, "Ark wallet is not ready");
  const token = newHumanToken();
  const agentId = randomUUID();
  await tx(async (db) => {
    await db.query(
      `INSERT INTO agents(id,name,token_hash,return_address,actor_type,metadata)
       VALUES($1,$2,$3,$4,'HUMAN',$5)`,
      [
        agentId,
        input.name,
        tokenHash(randomBytes(32).toString("base64url")),
        input.returnAddress,
        { source: "human_web" },
      ],
    );
    await db.query(
      `INSERT INTO human_sessions(id,agent_id,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '1 year')`,
      [randomUUID(), agentId, tokenHash(token)],
    );
    await event(db, "human_profile_created", null, { agentId });
  });
  return {
    token,
    profile: {
      id: agentId,
      name: input.name,
      returnAddress: input.returnAddress,
    },
  };
}
export async function recoverHuman(token: string) {
  if (!tokenPattern.test(token))
    throw new ApiError(401, "Invalid recovery code");
  const row = (
    await pool.query(
      `SELECT a.id,a.name,a.return_address
       FROM human_sessions s JOIN agents a ON a.id=s.agent_id
       WHERE s.token_hash=$1 AND s.revoked=false AND s.expires_at>now()
         AND a.enabled=true AND a.actor_type='HUMAN'`,
      [tokenHash(token)],
    )
  ).rows[0];
  if (!row) throw new ApiError(401, "Invalid or expired recovery code");
  return {
    token,
    profile: {
      id: row.id,
      name: row.name,
      returnAddress: row.return_address,
    },
  };
}
export async function humanMe(agentId: string) {
  const agent = (
    await pool.query(
      "SELECT id,name,return_address FROM agents WHERE id=$1 AND actor_type='HUMAN' AND enabled=true",
      [agentId],
    )
  ).rows[0];
  if (!agent) throw new ApiError(404, "Player not found");
  const bets = (
    await pool.query(
      `SELECT b.id,b.round_id,b.direction,b.amount::text,b.status,b.response,b.created_at,b.accepted_at,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'amountSats',s.amount::text,'status',o.status,'confirmedAt',o.confirmed_at)),'[]')
         FROM settlement_obligations s JOIN outgoing_payments o ON o.id=s.id WHERE s.bet_id=b.id) AS outgoing
       FROM bets b WHERE b.agent_id=$1 ORDER BY b.created_at DESC LIMIT 20`,
      [agentId],
    )
  ).rows;
  return {
    profile: {
      id: agent.id,
      name: agent.name,
      returnAddress: agent.return_address,
    },
    performance: (await performance(agentId))[0] ?? null,
    bets,
  };
}
export async function createHumanBet(
  agentId: string,
  input: z.infer<typeof humanBet>,
  adapter: ArkPaymentAdapter = ark,
  clock?: Date,
) {
  const agent = (
    await pool.query(
      "SELECT return_address FROM agents WHERE id=$1 AND actor_type='HUMAN' AND enabled=true",
      [agentId],
    )
  ).rows[0];
  if (!agent) throw new ApiError(401, "Human session required");
  const intent = await createIntent(
    agentId,
    { ...input, returnAddress: agent.return_address },
    adapter,
    clock,
  );
  return {
    status: "PAYMENT_REQUIRED",
    betId: intent.betId,
    direction: intent.direction,
    payment: {
      destination: intent.paymentRequest,
      amountSats: intent.amountSats,
      expiresAt: intent.lockTimestamp,
    },
    qrUrl: `${config.PUBLIC_APP_URL}/api/v1/humans/bets/${intent.betId}/qr`,
    keelUrl: config.KEEL_APP_URL,
    message:
      "Scan the QR for the address, enter the exact displayed amount in Keel, and approve once.",
  };
}
export async function confirmHumanBet(
  agentId: string,
  betId: string,
  adapter: ArkPaymentAdapter = ark,
) {
  const bet = await getBet(betId, agentId);
  if (!bet) throw new ApiError(404, "Bet not found");
  const reference = (
    await pool.query("SELECT receive_reference FROM bets WHERE id=$1", [betId])
  ).rows[0].receive_reference;
  for (const receipt of await adapter.lookupIncomingPayment(reference))
    await receivePayment(betId, receipt);
  const updated = await getBet(betId, agentId);
  const awaiting = updated.status === "AWAITING_PAYMENT";
  return {
    httpStatus: awaiting ? 402 : 200,
    body: {
      status: updated.status,
      betId,
      accepted: !!updated.accepted_at,
      outgoing: updated.outgoing,
      message: awaiting
        ? "Waiting for the exact Ark payment. Do not pay twice."
        : updated.accepted_at
          ? "Bet accepted."
          : "Payment was not eligible; any received sats will be refunded.",
    },
  };
}
export async function humanBetQr(agentId: string, betId: string) {
  const bet = await getBet(betId, agentId);
  if (!bet) throw new ApiError(404, "Bet not found");
  return QRCode.toString(bet.response.paymentRequest, {
    type: "svg",
    width: 300,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#080d15", light: "#ffffff" },
  });
}
