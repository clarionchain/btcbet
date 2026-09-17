# Operator runbook

Secrets live in `.env` (mode 0600), excluded from Git and the Docker build context. Never paste them into tickets or browser URLs.

## Deploy / update

```sh
docker compose build app
docker compose up -d db
docker compose run --rm app npm run migrate
docker compose up -d app worker
curl -f http://127.0.0.1:3085/btcbet/api/ready
```

Image `btcbet:0.1.0`; app container `btcbet-app`, port 3085. Database host port 5485 binds loopback only. Production build: `npm run build`. Start: `npm start`. Migration: `npm run migrate`. Worker: `npm run worker`. Use Node 22.

## Health and logs

```sh
docker compose ps
docker compose logs --tail=100 app worker
docker compose exec -T app npm run admin -- status
docker compose exec -T app npm run admin -- wallet
```

`/btcbet/api/health` reports process/DB/feed/worker/wallet and aggregate outgoing status. `/btcbet/api/ready` returns 503 for stale feed/worker or unready wallet. The read-only `/btcbet/api/v1/admin/status` requires `Authorization: Bearer <ADMIN_SECRET>`.

## Agent operations

```sh
# Public agent onboarding: /btcbet/agents.md (402 payment authentication)
docker compose exec -T app npm run admin -- list
docker compose exec -T app npm run admin -- disable AGENT_UUID --confirm
docker compose exec -T app npm run admin -- enable AGENT_UUID --confirm
docker compose exec -T app npm run admin -- rotate AGENT_UUID --confirm
docker compose exec -T app npm run admin -- revoke AGENT_UUID --confirm
```

Creation/rotation prints the bearer token once. Only an HMAC-SHA256 hash is stored. The pepper and admin secret are generated independently. Mock addresses cannot accept real Ark transfers. Real mode accepts valid Second signet addresses. Rotation/revocation also invalidates payment sessions.

## Pause, void and failed transfers

```sh
docker compose exec -T app npm run admin -- pause --confirm
docker compose exec -T app npm run admin -- resume --confirm
docker compose exec -T app npm run admin -- void ROUND_ID --confirm
docker compose exec -T app npm run admin -- retry OBLIGATION_ID --confirm
```

Pause blocks new intents, while existing payments/settlements continue. Void is limited to unresolved rounds and serializes with worker settlement. Failed mock sends can retry using their original durable reference; up to eight attempts with bounded exponential delays before operator action. Never manually mark an outgoing transfer confirmed without external evidence. Real CLI sends persist a pre-send history baseline. UNKNOWN outcomes only reconcile; they never automatically resend and block later outgoing transfers. Inspect unresolvedArkSends in the protected admin status response.

The worker recovers persisted rounds, expires unpaid intents, polls all historical receive references, reconciles payments before resolving and retries pending sends. A stale heartbeat or observation age fails readiness. Feed reconnects to Coinbase only; missing resolution samples cause a refund. Keep reliable UTC synchronization running.

## Demo and tests

```sh
docker compose exec -T app npm run demo
```

Creates clearly named Demo Atlas (UP) and Demo Vector (DOWN), simulated 1,000-sat receipts, and lets the real worker settle from stored Coinbase data. Run with at least ten seconds left before lock. Demo tokens are not printed or saved; rotate a token if needed. It does not manufacture price observations.

For isolated deterministic tests, create `btcbet_test` once:

```sh
docker compose exec -T db createdb -U btcbet btcbet_test
# Inside Node 22 with .env and DB access:
npm run test:db
npm run typecheck
npm run test:browser
```

Tests require a separate test database and fail before writes if pointed at production. Browser tests use the local production app plus deterministic intercepted dashboard/SSE responses.

## PostgreSQL backups

```sh
mkdir -p backups
chmod 700 backups
docker compose exec -T db pg_dump -U btcbet -Fc btcbet > backups/ledger.dump
chmod 600 backups/ledger.dump
```

Copy encrypted backups off the host and test restoration into a separate database. Back up `.env` securely as well, especially `AGENT_TOKEN_PEPPER`. Do not delete payment/audit rows. This deployment does not configure a recurring offsite backup schedule.

## Rollback

Before upgrading, record `docker image inspect btcbet:0.1.0 --format '{{.Id}}'` and tag it `btcbet:previous`; back up the ledger. On failure, pause betting, stop only the BTCBet app/worker, restore the previous image tag and restart. Migration 001 is additive and has no destructive down migration. Restore DB backups only after reconciling all transfers since the snapshot; blind financial rollback can cause duplicate payments.

Reverse-proxy config should only match `/btcbet` and `/btcbet/*`. Reload after editing; do not replace an entire proxy file and wipe other sites. See [Caddy.btcbet](Caddy.btcbet).

## Dedicated Ark wallet

Use `ARK_ADAPTER=second`, `ARK_WALLET_CONFIG=/wallet`, and the Second signet server URL. Compose mounts `.wallet` into app and worker. Keep directory mode 0700 and back it up encrypted alongside the database and secrets. Do not run another sender against this wallet. Before maintenance, pause new betting and stop app/worker so no CLI operation overlaps; use the pinned Bark CLI's `maintain`/`refresh` commands and inspect VTXO expiry. Resume after verifying balance, pending obligations and readiness. Signet VTXOs expire; this MVP does not schedule automatic refresh.

Never change adapter modes mid-round expecting existing intents to convert. Wait for a fresh round. Real outgoing sends exclude mock rounds. Do not roll back to a build without these guards after accepting real payments.

`scripts/verify-signet.ts` is an explicit real-transfer check restricted to `btcbet_signet_verify`, with a separately funded sender wallet and staging HTTP server. It uses deterministic prices only in that isolated database, verifies 402, payment-gated authentication, replay, mismatch refund and winner payout. It must not run against the production database. Keep this ledger when real movements have occurred; do not casually reset it.
