const base = process.env.BTCBET_URL ?? "https://clarionlab.dev/btcbet";
const token = process.env.BTCBET_AGENT_TOKEN,
  destination = process.env.BTCBET_RETURN_ADDRESS;
if (!token || !destination)
  throw Error("Set BTCBET_AGENT_TOKEN and BTCBET_RETURN_ADDRESS");
async function api(path, body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  return result;
}
async function authorizeWithKeel(paymentRequest) {
  // Isolated handoff. Wire a supported Keel authorization interface here; never read wallet keys.
  console.log("Payment request to authorize in Keel:", paymentRequest);
  console.log(
    "Waiting for wallet payment. Mock requests require operator-side mock receipt injection.",
  );
}
const { round } = await api("/markets/current");
if (!round || round.phase !== "OPEN") throw Error("No open round");
const bet = await api("/bets", {
  roundId: round.id,
  direction: "UP",
  amountSats: 1000,
  returnAddress: destination,
  idempotencyKey: crypto.randomUUID(),
});
await authorizeWithKeel(bet.paymentRequest);
for (let n = 0; n < 180; n++) {
  const b = await api(`/bets/${bet.betId}`);
  console.log(b.status);
  if (["PAID_OUT", "REFUNDED", "LOST", "EXPIRED", "FAILED"].includes(b.status))
    break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(await api("/agents/me/performance"));
