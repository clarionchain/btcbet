import { pool } from "./db";
import { config, rules } from "./config";
import { boundary } from "./math";
import { ark } from "./ark";
export async function health() {
  try {
    await pool.query("SELECT 1");
    const last = (
      await pool.query(
        "SELECT max(received_at) AS at FROM price_observations WHERE provider=$1",
        [config.PRICE_PROVIDER],
      )
    ).rows[0].at;
    const worker = (
      await pool.query(
        "SELECT value FROM system_settings WHERE key='worker_heartbeat'",
      )
    ).rows[0]?.value;
    const counts = (
      await pool.query(
        "SELECT count(*) FILTER(WHERE status!='CONFIRMED')::int AS pending,count(*) FILTER(WHERE status IN ('FAILED','UNKNOWN'))::int AS failed FROM outgoing_payments",
      )
    ).rows[0];
    const wallet = await ark.getWalletStatus();
    const priceAge = last ? (Date.now() - +last) / 1000 : null;
    const workerAge = worker ? (Date.now() - +new Date(worker)) / 1000 : null;
    const ready = !!(
      wallet.ready &&
      priceAge !== null &&
      priceAge < 15 &&
      workerAge !== null &&
      workerAge < 15
    );
    return {
      status: ready ? "ready" : "degraded",
      database: true,
      provider: config.PRICE_PROVIDER,
      priceAgeSeconds: priceAge,
      workerAgeSeconds: workerAge,
      wallet,
      pendingPayments: counts.pending,
      failedPayments: counts.failed,
      network: "signet",
      serverTime: new Date().toISOString(),
    };
  } catch {
    return {
      status: "unavailable",
      database: false,
      network: "signet",
      serverTime: new Date().toISOString(),
    };
  }
}
export async function performance(agentId?: string) {
  const agents = (
    await pool.query(
      `SELECT id,name,actor_type FROM agents
       WHERE (identity_key IS NULL OR payment_authenticated_at IS NOT NULL)
         AND (actor_type!='HUMAN' OR EXISTS(SELECT 1 FROM bets WHERE agent_id=agents.id AND accepted_at IS NOT NULL))
         AND ($1::uuid IS NULL OR id=$1) ORDER BY name`,
      [agentId ?? null],
    )
  ).rows;
  const rows = (
    await pool.query(
      `SELECT b.id,b.agent_id,b.round_id,b.direction,b.amount::text,b.status,b.accepted_at,r.outcome,r.reason,r.start_at,coalesce((SELECT sum(s.amount) FROM settlement_obligations s JOIN outgoing_payments o ON o.id=s.id WHERE s.bet_id=b.id AND s.incoming_id IS NULL AND o.status='CONFIRMED'),0)::text AS returned FROM bets b JOIN rounds r ON r.id=b.round_id WHERE ($1::uuid IS NULL OR b.agent_id=$1) ORDER BY r.start_at DESC,b.id`,
      [agentId ?? null],
    )
  ).rows;
  return agents
    .map((a) => {
      const all = rows.filter((b) => b.agent_id === a.id),
        accepted = all.filter((b) => b.accepted_at),
        done = accepted.filter((b) =>
          ["LOST", "PAID_OUT", "REFUNDED"].includes(b.status),
        ),
        wins = done.filter((b) => b.status === "PAID_OUT").length,
        losses = done.filter((b) => b.status === "LOST").length,
        voids = done.filter((b) => b.status === "REFUNDED").length;
      let streak = 0;
      for (const b of done) {
        if (b.status === "REFUNDED") continue;
        const n = b.status === "PAID_OUT" ? 1 : -1;
        if (streak && Math.sign(streak) !== n) break;
        streak += n;
      }
      const wagered = accepted.reduce((n, b) => n + BigInt(b.amount), 0n);
      const returned = accepted.reduce((n, b) => n + BigInt(b.returned), 0n);
      return {
        ...a,
        betsPlaced: all.length,
        bets: accepted.length,
        wins,
        losses,
        voids,
        winRate: wins + losses ? wins / (wins + losses) : 0,
        totalWagered: wagered.toString(),
        totalReturned: returned.toString(),
        netSats: (returned - wagered).toString(),
        streak,
        recentHistory: agentId ? all.slice(0, 20) : undefined,
      };
    })
    .sort((a, b) => Number(BigInt(b.netSats) - BigInt(a.netSats)));
}
export async function roundView(id: string) {
  const round = (await pool.query("SELECT * FROM rounds WHERE id=$1", [id]))
    .rows[0];
  if (!round) return null;
  const pools = (
    await pool.query(
      `SELECT direction,sum(amount)::text AS sats,count(*)::int AS count FROM bets WHERE round_id=$1 AND accepted_at IS NOT NULL GROUP BY direction`,
      [id],
    )
  ).rows;
  const up = pools.find((x) => x.direction === "UP"),
    down = pools.find((x) => x.direction === "DOWN");
  const total = BigInt(up?.sats ?? 0) + BigInt(down?.sats ?? 0);
  const positions = (
    await pool.query(
      `SELECT b.id,a.name,a.actor_type,b.direction,b.amount::text,b.status,b.created_at,b.accepted_at, (SELECT s.amount::text FROM settlement_obligations s WHERE s.bet_id=b.id AND s.incoming_id IS NULL) AS final_payout FROM bets b JOIN agents a ON a.id=b.agent_id WHERE round_id=$1 ORDER BY b.created_at DESC LIMIT 100`,
      [id],
    )
  ).rows;
  return {
    ...round,
    upPool: up?.sats ?? "0",
    downPool: down?.sats ?? "0",
    upCount: up?.count ?? 0,
    downCount: down?.count ?? 0,
    totalPool: total.toString(),
    upPercentage: total
      ? Number((BigInt(up?.sats ?? 0) * 10000n) / total) / 100
      : 0,
    downPercentage: total
      ? 100 - Number((BigInt(up?.sats ?? 0) * 10000n) / total) / 100
      : 0,
    positions,
    secondsRemaining: Math.max(
      0,
      Math.ceil((+round.end_at - Date.now()) / 1000),
    ),
  };
}
export async function history() {
  const ids = (
    await pool.query(
      "SELECT id FROM rounds WHERE phase NOT IN ('OPEN','LOCKED','UPCOMING') ORDER BY start_at DESC LIMIT 20",
    )
  ).rows;
  return Promise.all(ids.map((r) => roundView(r.id)));
}
export async function current(agentId?: string) {
  const id = String(boundary(Date.now()) / 1000);
  const round = await roundView(id);
  const observations = (
    await pool.query(
      "SELECT provider_at AS time,price::text FROM price_observations WHERE provider=$1 AND pair=$2 AND provider_at >=$3 AND provider_at<$4 ORDER BY provider_at,id",
      [
        config.PRICE_PROVIDER,
        config.PRICE_PAIR,
        new Date(Number(id) * 1000),
        new Date(Number(id) * 1000 + 300000),
      ],
    )
  ).rows;
  const latest =
    (
      await pool.query(
        "SELECT price::text,provider_at,received_at FROM price_observations WHERE provider=$1 ORDER BY provider_at DESC LIMIT 1",
        [config.PRICE_PROVIDER],
      )
    ).rows[0] ?? null;
  const bet = agentId
    ? ((
        await pool.query(
          "SELECT id,status,direction,amount::text FROM bets WHERE agent_id=$1 AND round_id=$2 ORDER BY accepted_at DESC NULLS LAST,created_at DESC LIMIT 1",
          [agentId, id],
        )
      ).rows[0] ?? null)
    : null;
  return {
    round,
    currentPrice: latest?.price ?? null,
    currentPriceTime: latest?.provider_at ?? null,
    observations,
    existingBet: bet,
    rules,
    serverTime: new Date().toISOString(),
    adapter: config.ARK_ADAPTER,
  };
}
export async function getBet(id: string, agentId: string) {
  return (
    await pool.query(
      `SELECT b.id,b.round_id,b.direction,b.amount::text,b.status,b.response,b.created_at,b.accepted_at,(SELECT coalesce(jsonb_agg(jsonb_build_object('amountSats',p.amount::text,'receivedAt',p.received_at,'disposition',p.disposition)),'[]') FROM incoming_payments p WHERE p.bet_id=b.id) AS payments,(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'amountSats',s.amount::text,'status',o.status,'confirmedAt',o.confirmed_at)),'[]') FROM settlement_obligations s JOIN outgoing_payments o ON o.id=s.id WHERE s.bet_id=b.id) AS outgoing FROM bets b WHERE b.id=$1 AND b.agent_id=$2`,
      [id, agentId],
    )
  ).rows[0];
}
