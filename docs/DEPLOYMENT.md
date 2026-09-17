# Deployment

BTCBet is one Docker image and two processes: the Next.js app and the worker. PostgreSQL holds the ledger. Reverse-proxy the app at `/btcbet` and disable response buffering so the live event stream is not held back.

## Prepare

1. Copy `.env.example` to `.env`. Generate a database password and two independent secrets of at least 32 characters. Mode `0600` on `.env`.
2. For mock payments, `ARK_ADAPTER=mock` is enough. For real Signet Ark, set `ARK_ADAPTER=second`, `ARK_NETWORK=signet`, and point `ARK_WALLET_CONFIG` at a dedicated house-wallet directory (mode `0700`). Do not reuse a Keel user wallet.
3. `PUBLIC_BASE_PATH` must stay `/btcbet` unless you also change Next.js `basePath`.

## Compose

```sh
docker compose build app
docker compose up -d db
docker compose run --rm app npm run migrate
docker compose up -d app worker
curl -f http://127.0.0.1:3085/btcbet/api/ready
```

The published Compose file binds Postgres to loopback port 5485 and the app to loopback 3085. It also expects an external Docker network named `cc-stack_default` so an existing reverse proxy can reach the app. If you do not have that network, create it or edit the `caddy` network in `compose.yaml` before `up`.

Image tag: `btcbet:0.1.0`. Use Node 22 in containers.

## Reverse proxy

See [Caddy.btcbet](Caddy.btcbet) for a Caddy snippet that preserves `/btcbet` and flushes SSE immediately. Point it at `btcbet-app:3085` (or `127.0.0.1:3085` on the host). Reload the proxy; do not paste this block over unrelated site config.

## Hosting notes

A platform that only runs `next build` (including Vercel) can serve the dashboard and API **if** you also provide:

- PostgreSQL (`DATABASE_URL`)
- All secrets from `.env.example`
- A process that keeps `npm run worker` running (price feed and settlement)

Without the worker, rounds do not open, close, or pay. The site path is `/btcbet`.
