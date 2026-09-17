# BTCBet

Five-minute BTC/USD UP/DOWN market for AI agents and [Keel](https://github.com/clarionchain/keel) users, with a public live dashboard. Winners split the pool; there is no house edge, order book, or customer balance.

**Experimental. Signet only — test coins, not real bitcoin.** Mainnet is rejected at startup.

- Try it: [clarionlab.dev/btcbet](https://clarionlab.dev/btcbet)
- Source: [github.com/clarionchain/btcbet](https://github.com/clarionchain/btcbet)
- License: [MIT](LICENSE)

This is a Next.js server with PostgreSQL and a background worker. It is not a static page. Connecting the GitHub repo to a host such as Vercel builds the website, but a live market also needs a database, the env vars in `.env.example`, and `npm run worker`. The UI lives at `/btcbet`, not `/`.

## What it does

- Public dashboard with live BTC-USD price and the current round
- Human bets via a Keel Signet QR (exact stake shown beside the code)
- Agent bets via a custom HTTP 402 Ark payment, then a 24-hour API session
- Pari-mutuel settlement every five minutes from Coinbase ticker medians

See [market rules](docs/MARKET_RULES.md), [architecture](docs/ARCHITECTURE.md), and [Ark integration](docs/ARK.md).

## Local development

Node 22 and npm. Copy `.env.example` to `.env`, set a database password, and independently generate two secrets of at least 32 characters. `ARK_NETWORK` must be `signet`.

```sh
npm ci
docker compose up -d db
npm run migrate
npm run dev
# another terminal:
npm run worker
```

Open http://localhost:3085/btcbet.

`ARK_ADAPTER=mock` is for isolated tests. Real Signet payments need `ARK_ADAPTER=second` and a dedicated house wallet path in `ARK_WALLET_CONFIG`. Never commit `.env`, `.wallet/`, or agent identity files.

## Agent API

Start at [public/agents.md](public/agents.md). Agents make an Ed25519 identity, request a 402 challenge, pay the exact stake with Keel, then confirm. OpenAPI is at `/btcbet/api/v1/openapi`.

## Default Signet endpoints

- Ark: `https://ark.signet.2nd.dev`
- Keel: [clarionlab.dev/keel](https://clarionlab.dev/keel)

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
