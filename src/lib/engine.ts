import { randomUUID, createHash } from "node:crypto";
import { pool, tx, event, DB } from "./db";
import { config, rules } from "./config";
import { allocate, boundary, eligible, median, outcome } from "./math";
import { ark, ArkPaymentAdapter, Incoming } from "./ark";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export async function ensureRound(db: DB, now = new Date()) {
  const start = boundary(+now),
    id = String(start / 1000);
  const r = await db.query(
    `INSERT INTO rounds(id,start_at,lock_at,end_at,phase,provider,rules) VALUES($1,$2,$3,$4,'OPEN',$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
    [
      id,
      new Date(start),
      new Date(start + 300000 - config.BETTING_LOCK_SECONDS * 1000),
      new Date(start + 300000),
      config.PRICE_PROVIDER,
      rules,
    ],
  );
  if (r.rowCount) {
    await event(db, "round_created", id);
    await event(db, "round_opened", id);
  }
  return id;
}
export type Intent = {
  roundId: string;
  direction: "UP" | "DOWN";
  amountSats: number;
  returnAddress: string;
  idempotencyKey: string;
};
export async function createIntent(
  agentId: string,
  input: Intent,
  adapter = ark,
  clock?: Date,
) {
  return tx(async (db) => {
    const now =
      clock ?? (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const agent = (
      await db.query("SELECT * FROM agents WHERE id=$1 FOR UPDATE", [agentId])
    ).rows[0];
    if (!agent?.enabled) throw new ApiError(401, "Agent disabled");
    const digest = hash(
      JSON.stringify([
        input.roundId,
        input.direction,
        input.amountSats,
        input.returnAddress,
      ]),
    );
    const prior = (
      await db.query(
        "SELECT b.request_hash,b.response,coalesce(r.rules->>'paymentAdapter','mock') AS payment_mode FROM bets b JOIN rounds r ON r.id=b.round_id WHERE b.agent_id=$1 AND b.idempotency_key=$2",
        [agentId, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.payment_mode !== config.ARK_ADAPTER)
        throw new ApiError(409, "Payment mode changed; request a new bet");
      if (prior.request_hash !== digest)
        throw new ApiError(409, "Idempotency key reused with different data");
      return prior.response;
    }
    const rate = (
      await db.query(
        `INSERT INTO write_limits(agent_id,window_at,count) VALUES($1,$2,1) ON CONFLICT(agent_id) DO UPDATE SET count=CASE WHEN write_limits.window_at<$2-interval '1 minute' THEN 1 ELSE write_limits.count+1 END,window_at=CASE WHEN write_limits.window_at<$2-interval '1 minute' THEN $2 ELSE write_limits.window_at END RETURNING count`,
        [agentId, now],
      )
    ).rows[0];
    if (rate.count > 30) throw new ApiError(429, "Write rate limit reached");
    if (
      (await db.query("SELECT value FROM system_settings WHERE key='paused'"))
        .rows[0]?.value
    )
      throw new ApiError(503, "New betting paused");
    const round = (
      await db.query("SELECT * FROM rounds WHERE id=$1 FOR UPDATE", [
        input.roundId,
      ])
    ).rows[0];
    if (
      !round ||
      input.roundId !== String(boundary(+now) / 1000) ||
      round.phase !== "OPEN" ||
      +now >= +round.lock_at
    )
      throw new ApiError(409, "Round is not open");
    if ((round.rules.paymentAdapter ?? "mock") !== config.ARK_ADAPTER)
      throw new ApiError(409, "Payment mode changed; wait for the next round");
    if (!config.amounts.includes(input.amountSats))
      throw new ApiError(400, "Unsupported amount");
    if (!(await adapter.validateDestination(input.returnAddress)))
      throw new ApiError(
        400,
        "Invalid return destination for configured payment adapter",
      );
    if (!(await adapter.getWalletStatus()).ready)
      throw new ApiError(503, "Wallet not ready");
    if (
      (
        await db.query(
          "SELECT 1 FROM bets WHERE agent_id=$1 AND round_id=$2 AND accepted_at IS NOT NULL",
          [agentId, input.roundId],
        )
      ).rowCount
    )
      throw new ApiError(409, "Agent already has an accepted wager");
    // Reserve limits against outstanding intents as well as accepted wagers.
    const spent = (
      await db.query(
        `SELECT coalesce(sum(amount),0)::text AS total FROM bets WHERE agent_id=$1 AND created_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status NOT IN ('EXPIRED','FAILED','REFUNDED')`,
        [agentId, now],
      )
    ).rows[0].total;
    if (
      (agent.per_bet_limit &&
        BigInt(input.amountSats) > BigInt(agent.per_bet_limit)) ||
      (agent.daily_limit &&
        BigInt(spent) + BigInt(input.amountSats) > BigInt(agent.daily_limit))
    )
      throw new ApiError(422, "Agent spending limit exceeded");
    const id = randomUUID(),
      receive = await adapter.createReceiveRequest({
        reference: id,
        amount: String(input.amountSats),
      });
    const response = {
      betId: id,
      status: "AWAITING_PAYMENT",
      amountSats: input.amountSats,
      direction: input.direction,
      paymentRequest: receive.paymentRequest,
      paymentExpiration: round.lock_at,
      lockTimestamp: round.lock_at,
      message: "Not accepted until exact payment is received before lock.",
    };
    await db.query(
      `INSERT INTO bets(id,agent_id,round_id,direction,amount,return_address,idempotency_key,request_hash,status,receive_reference,response,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AWAITING_PAYMENT',$9,$10,$11)`,
      [
        id,
        agentId,
        input.roundId,
        input.direction,
        input.amountSats,
        input.returnAddress,
        input.idempotencyKey,
        digest,
        receive.reference,
        response,
        now,
      ],
    );
    await event(db, "bet_created", input.roundId, { betId: id });
    return response;
  });
}
async function obligation(
  db: DB,
  bet: any,
  amount: string,
  kind: "PAYOUT" | "REFUND",
  incomingId: string | null = null,
) {
  const id = incomingId ? `refund:${incomingId}` : `settle:${bet.id}`;
  await db.query(
    "INSERT INTO settlement_obligations(id,bet_id,incoming_id,kind,amount,destination) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [id, bet.id, incomingId, kind, amount, bet.return_address],
  );
  await db.query(
    "INSERT INTO outgoing_payments(id,idempotency_reference) VALUES($1,$1) ON CONFLICT DO NOTHING",
    [id],
  );
  await event(
    db,
    kind === "PAYOUT" ? "payout_calculated" : "refund_calculated",
    bet.round_id,
    { betId: bet.id, amountSats: amount },
  );
}
export async function receivePayment(betId: string, p: Incoming) {
  return tx(async (db) => {
    const ref = (
      await db.query("SELECT round_id,agent_id FROM bets WHERE id=$1", [betId])
    ).rows[0];
    if (!ref) throw Error("Unknown bet");
    // All acceptance/settlement locks take round before bet; API takes agent before round.
    const round = (
      await db.query("SELECT * FROM rounds WHERE id=$1 FOR UPDATE", [
        ref.round_id,
      ])
    ).rows[0];
    const bet = (
      await db.query("SELECT * FROM bets WHERE id=$1 FOR UPDATE", [betId])
    ).rows[0];
    if (
      (await db.query("SELECT 1 FROM incoming_payments WHERE id=$1", [p.id]))
        .rowCount
    )
      return;
    if (BigInt(p.amount) <= 0n || !Number.isFinite(+new Date(p.receivedAt)))
      throw Error("Invalid provider receipt");
    let disposition = "ACCEPTED";
    if (
      !["OPEN", "LOCKED"].includes(round.phase) ||
      +new Date(p.receivedAt) < +bet.created_at
    )
      disposition = "CLOSED_ROUND";
    else if (!eligible(+new Date(p.receivedAt), +round.lock_at))
      disposition = "LATE_PAYMENT";
    else if (BigInt(p.amount) !== BigInt(bet.amount))
      disposition = "AMOUNT_MISMATCH";
    else if (
      (
        await db.query(
          "SELECT 1 FROM bets WHERE agent_id=$1 AND round_id=$2 AND accepted_at IS NOT NULL",
          [bet.agent_id, bet.round_id],
        )
      ).rowCount
    )
      disposition = "DUPLICATE_BET";
    await db.query(
      "INSERT INTO incoming_payments(id,bet_id,amount,received_at,disposition) VALUES($1,$2,$3,$4,$5)",
      [p.id, betId, p.amount, p.receivedAt, disposition],
    );
    await event(db, "payment_confirmed", bet.round_id, { betId, disposition });
    if (disposition === "ACCEPTED") {
      await db.query(
        "UPDATE bets SET status='ACCEPTED',accepted_at=$2 WHERE id=$1",
        [betId, p.receivedAt],
      );
      await event(db, "bet_accepted", bet.round_id, { betId });
      await event(db, "pool_changed", bet.round_id);
    } else {
      await obligation(db, bet, p.amount, "REFUND", p.id);
      if (!bet.accepted_at)
        await db.query("UPDATE bets SET status='REFUND_PENDING' WHERE id=$1", [
          betId,
        ]);
      await event(db, "payment_rejected", bet.round_id, {
        betId,
        reason: disposition,
      });
    }
  });
}
export async function reconcile(adapter: ArkPaymentAdapter = ark) {
  await adapter.prepareReconciliation?.();
  // Watch all issued references, including expired/settled ones: delayed and duplicate transfers still need refunds.
  const bets = (
    await pool.query(
      "SELECT id,receive_reference FROM bets ORDER BY created_at",
    )
  ).rows;
  for (const bet of bets)
    for (const p of await adapter.lookupIncomingPayment(bet.receive_reference))
      await receivePayment(bet.id, p);
}
async function windowPrice(db: DB, r: any, start: Date, end: Date) {
  const p = (
    await db.query(
      `SELECT price::text FROM price_observations WHERE provider=$1 AND pair=$2 AND provider_at >= $3 AND provider_at < $4 AND received_at<=provider_at+interval '2 seconds' AND received_at>=provider_at-interval '1 second' ORDER BY provider_at,id`,
      [r.provider, r.rules.pair, start, end],
    )
  ).rows;
  return p.length >= r.rules.minObservations
    ? median(p.map((x) => x.price))
    : null;
}
export async function settle(
  roundId: string,
  now = new Date(),
  forceReason?: string,
) {
  await tx(async (db) => {
    const r = (
      await db.query("SELECT * FROM rounds WHERE id=$1 FOR UPDATE", [roundId])
    ).rows[0];
    if (!r || !["OPEN", "LOCKED"].includes(r.phase)) return;
    if (
      !r.opening &&
      +now >= +r.start_at + r.rules.openWindowSeconds * 1000 + 2000
    ) {
      const opening = await windowPrice(
        db,
        r,
        r.start_at,
        new Date(+r.start_at + r.rules.openWindowSeconds * 1000),
      );
      if (opening) {
        await db.query("UPDATE rounds SET opening=$2 WHERE id=$1", [
          r.id,
          opening,
        ]);
        r.opening = opening;
        await event(db, "opening_price_fixed", r.id, { price: opening });
      }
    }
    if (+now >= +r.lock_at && r.phase === "OPEN") {
      await db.query("UPDATE rounds SET phase='LOCKED' WHERE id=$1", [r.id]);
      await event(db, "round_locked", r.id);
    }
    if (!forceReason && +now < +r.end_at + 3000) return;
    r.closing = await windowPrice(
      db,
      r,
      new Date(+r.end_at - r.rules.closeWindowSeconds * 1000),
      r.end_at,
    );
    const bets = (
      await db.query(
        "SELECT * FROM bets WHERE round_id=$1 AND accepted_at IS NOT NULL ORDER BY id",
        [r.id],
      )
    ).rows;
    const win = r.opening && r.closing ? outcome(r.opening, r.closing) : null;
    const allocation = win
      ? allocate(
          bets.map((b) => ({
            id: b.id,
            direction: b.direction,
            amount: BigInt(b.amount),
          })),
          win,
        )
      : null;
    const reason =
      forceReason ??
      (!win
        ? "Insufficient authoritative price observations"
        : allocation?.voided
          ? "One-sided pool"
          : null);
    await db.query(
      "UPDATE rounds SET closing=$2,outcome=$3,reason=$4,phase=$5 WHERE id=$1",
      [r.id, r.closing, win, reason, reason ? "VOIDED" : "RESOLVED"],
    );
    await event(db, "closing_price_fixed", r.id, { price: r.closing });
    await event(db, reason ? "round_voided" : "round_resolved", r.id, {
      outcome: win,
      reason,
    });
    for (const b of bets) {
      const amount = reason
        ? b.amount
        : allocation!.payouts.find((p) => p.id === b.id)?.amount.toString();
      if (amount) {
        await obligation(db, b, amount, reason ? "REFUND" : "PAYOUT");
        await db.query("UPDATE bets SET status=$2 WHERE id=$1", [
          b.id,
          reason ? "REFUND_PENDING" : "PAYOUT_PENDING",
        ]);
      } else
        await db.query("UPDATE bets SET status='LOST' WHERE id=$1", [b.id]);
    }
    await db.query("UPDATE rounds SET phase=$2 WHERE id=$1", [
      r.id,
      bets.length
        ? reason
          ? "REFUNDING"
          : "PAYING"
        : reason
          ? "REFUNDED"
          : "PAID",
    ]);
    await db.query(
      "UPDATE bets SET status='EXPIRED' WHERE round_id=$1 AND status='AWAITING_PAYMENT'",
      [r.id],
    );
  });
}
export async function payOutgoing(
  adapter: ArkPaymentAdapter = ark,
  now = new Date(),
) {
  const rows = (
    await pool.query(
      `SELECT o.*,s.amount,s.destination,s.kind,s.bet_id,s.incoming_id FROM outgoing_payments o JOIN settlement_obligations s ON s.id=o.id JOIN bets b ON b.id=s.bet_id JOIN rounds r ON r.id=b.round_id WHERE coalesce(r.rules->>'paymentAdapter','mock')=$2 AND o.status IN ('PENDING','SENDING','FAILED') AND o.next_attempt_at <= $1 AND o.attempts<8 ORDER BY s.created_at LIMIT 100`,
      [now, config.ARK_ADAPTER],
    )
  ).rows;
  for (const o of rows) {
    await pool.query(
      "UPDATE outgoing_payments SET status='SENDING',attempts=attempts+1 WHERE id=$1",
      [o.id],
    );
    try {
      const result = await adapter.sendPayment({
        reference: o.idempotency_reference,
        amount: o.amount,
        destination: o.destination,
      });
      if (!result.confirmed) throw Error("Awaiting provider confirmation");
      await tx(async (db) => {
        await db.query(
          "UPDATE outgoing_payments SET status='CONFIRMED',provider_id=$2,confirmed_at=now(),last_error=NULL WHERE id=$1",
          [o.id, result.id],
        );
        const bet = (
          await db.query("SELECT * FROM bets WHERE id=$1 FOR UPDATE", [
            o.bet_id,
          ])
        ).rows[0];
        if (!o.incoming_id || !bet.accepted_at) {
          const pending = (
            await db.query(
              "SELECT 1 FROM outgoing_payments p JOIN settlement_obligations s ON p.id=s.id WHERE s.bet_id=$1 AND p.status!='CONFIRMED'",
              [o.bet_id],
            )
          ).rowCount;
          if (!pending)
            await db.query("UPDATE bets SET status=$2 WHERE id=$1", [
              o.bet_id,
              o.kind === "PAYOUT" ? "PAID_OUT" : "REFUNDED",
            ]);
        }
        await event(
          db,
          o.kind === "PAYOUT" ? "payout_updated" : "refund_sent",
          bet.round_id,
          { betId: o.bet_id, status: "CONFIRMED" },
        );
      });
    } catch {
      await pool.query(
        "UPDATE outgoing_payments SET status='FAILED',last_error='Adapter send failed; see adapter readiness',next_attempt_at=$2 WHERE id=$1",
        [o.id, new Date(+now + Math.min(300000, 1000 * 2 ** (o.attempts + 1)))],
      );
      await event(pool, "operational_failure", null, {
        operation: "outgoing_payment",
        obligationId: o.id,
      });
    }
  }
  await pool.query(
    `UPDATE rounds r SET phase=CASE WHEN r.phase='REFUNDING' THEN 'REFUNDED' ELSE 'PAID' END WHERE phase IN ('PAYING','REFUNDING') AND NOT EXISTS(SELECT 1 FROM bets b JOIN settlement_obligations s ON s.bet_id=b.id JOIN outgoing_payments o ON o.id=s.id WHERE b.round_id=r.id AND o.status!='CONFIRMED')`,
  );
}
export async function tick(now = new Date(), adapter: ArkPaymentAdapter = ark) {
  const lock = await pool.connect();
  try {
    if (
      !(await lock.query("SELECT pg_try_advisory_lock(7285301) AS held"))
        .rows[0].held
    )
      return;
    await tx(async (db) => {
      // Recover missing boundaries since the last known round; bounded batch to avoid long startup locks.
      const latest = (
        await db.query("SELECT max(start_at) AS start FROM rounds")
      ).rows[0].start;
      const saved = (
        await db.query(
          "SELECT value FROM system_settings WHERE key='recovery_cursor'",
        )
      ).rows[0]?.value;
      let next = saved
        ? Number(saved)
        : latest
          ? +latest + 300000
          : boundary(+now);
      let n = 0;
      for (; next <= boundary(+now) && n < 2016; next += 300000, n++)
        await ensureRound(db, new Date(next));
      await db.query(
        "INSERT INTO system_settings(key,value) VALUES('recovery_cursor',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",
        [JSON.stringify(next)],
      );
      await ensureRound(db, now);
    });
    await reconcile(adapter);
    for (const r of (
      await pool.query(
        "SELECT id FROM rounds WHERE phase IN ('OPEN','LOCKED') ORDER BY start_at",
      )
    ).rows)
      await settle(r.id, now);
    await payOutgoing(adapter, now);
    await pool.query(
      `INSERT INTO system_settings(key,value) VALUES('worker_heartbeat',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()`,
      [JSON.stringify(now.toISOString())],
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(7285301)");
    lock.release();
  }
}
