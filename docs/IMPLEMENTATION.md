# Implementation constraints

One image, two Node 22 processes: Next.js on port 3085 with URL prefix `/btcbet`, and a worker that ingests prices and settles rounds. PostgreSQL is the ledger. Reverse-proxy the prefix as-is and flush the event stream immediately.

Bark CLI in the image is pinned to `cashu-bark:e3d4174ca08a3c97bc23e1e73aa5332d725a7689` (Bark 0.6.2-dev). Address checks use `@secondts/bark` 0.23.0. The house wallet is dedicated to BTCBet; do not reuse a Keel user wallet. CLI `send` has no idempotency key, so the adapter records a pre-send history baseline and never automatically resends after an ambiguous result. See [ARK.md](ARK.md).

Price source is Coinbase Exchange BTC-USD ticker WebSocket only ([channel docs](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)). Store valid ticker observations (batches of cascading trades), not every exchange trade. Opening and closing prices are five-second medians from provider timestamps, with a minimum sample count. Gaps invalidate the affected window.

`.npmrc` uses legacy peer resolution so npm does not crash on optional Vite/Vitest peers; test versions are pinned.
