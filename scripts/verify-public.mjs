const base = "https://clarionlab.dev/btcbet";
for (const p of [
  "",
  "/api/health",
  "/api/ready",
  "/api/v1/markets/current",
  "/api/v1/openapi",
]) {
  const r = await fetch(base + p);
  console.log(p || "dashboard", r.status);
  if (!r.ok) process.exitCode = 1;
}
const stream = await fetch(base + "/api/v1/events", {
  signal: AbortSignal.timeout(15000),
});
const reader = stream.body.getReader();
const first = await reader.read();
console.log(
  "SSE",
  stream.status,
  stream.headers.get("content-type"),
  new TextDecoder().decode(first.value).slice(0, 150),
);
await reader.cancel();
