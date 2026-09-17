import Decimal from "decimal.js";
export type Side = "UP" | "DOWN";
export function boundary(ms: number) {
  return Math.floor(ms / 300000) * 300000;
}
export function eligible(received: number, lock: number) {
  return received < lock;
}
export function median(prices: string[]) {
  if (!prices.length) return null;
  const sorted = prices.map((p) => new Decimal(p)).sort((a, b) => a.cmp(b));
  const i = Math.floor(sorted.length / 2);
  return (
    sorted.length % 2 ? sorted[i] : sorted[i - 1].plus(sorted[i]).div(2)
  ).toFixed(8);
}
export function outcome(open: string, close: string): Side {
  return new Decimal(close).gte(open) ? "UP" : "DOWN";
}
export function allocate(
  bets: { id: string; direction: Side; amount: bigint }[],
  win: Side,
) {
  const up = bets.filter((b) => b.direction === "UP"),
    down = bets.filter((b) => b.direction === "DOWN");
  if (!up.length || !down.length)
    return {
      voided: bets.length > 0,
      payouts: bets.map((b) => ({ id: b.id, amount: b.amount })),
    };
  const pool = bets.reduce((n, b) => n + b.amount, 0n),
    winners = bets.filter((b) => b.direction === win),
    stake = winners.reduce((n, b) => n + b.amount, 0n);
  const p = winners
    .map((b) => ({
      id: b.id,
      amount: (b.amount * pool) / stake,
      remainder: (b.amount * pool) % stake,
    }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  let rest = pool - p.reduce((n, b) => n + b.amount, 0n);
  for (const b of p) {
    if (rest-- > 0n) b.amount++;
  }
  return {
    voided: false,
    payouts: p.map(({ id, amount }) => ({ id, amount })),
  };
}
export function sameIntent(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
const transitions: Record<string, string[]> = {
  CREATED: ["AWAITING_PAYMENT", "FAILED"],
  AWAITING_PAYMENT: ["ACCEPTED", "REFUND_PENDING", "EXPIRED"],
  EXPIRED: ["REFUND_PENDING"],
  ACCEPTED: ["LOST", "PAYOUT_PENDING", "REFUND_PENDING"],
  PAYOUT_PENDING: ["PAID_OUT"],
  REFUND_PENDING: ["REFUNDED"],
};
export function assertTransition(from: string, to: string) {
  if (!transitions[from]?.includes(to))
    throw Error(`Invalid transition ${from} -> ${to}`);
}
