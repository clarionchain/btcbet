# Verification — 2026-09-08

- Node 22 production build and TypeScript checks pass.
- Vitest: 22 passing tests (9 rules/math/config, 13 PostgreSQL integration). Test DB resets are restricted to `btcbet_test`.
- Playwright: 2 passing scenarios: actual dashboard/subpath assets/price/countdown/mobile layout; deterministic pending → accepted → locked → paid UI with history/leaderboard updates. The actual dashboard scenario also passed against https://clarionlab.dev/btcbet.
- npm dependency audit: zero vulnerabilities, including development dependencies during image install; production-only audit also zero.
- Unauthenticated bet creation and admin status requests return 401.
- HTTP/SSE public verification succeeds; existing root (302) and Keel (200) responses preserved.

## Live full round

Round `1788848700`, 2026-09-08 06:25:00–06:30:00 UTC:
- Coinbase opening median: **78412.37000000 USD**.
- Coinbase closing median: **78356.38000000 USD**.
- Outcome: **DOWN**. Round: **PAID**.
- Demo Atlas: UP, 1,000 simulated sats, LOST.
- Demo Vector: DOWN, 1,000 simulated sats, PAID_OUT, **2,000 simulated sats** returned.
- App/worker recreated during this round; opening and accepted positions survived.
- Financial totals: 2,000 accepted sats = 2,000 returned sats, no house fee.

Startup partial round `1788848400` had no opening window data and correctly refunded both 1,000-sat wagers. Incoming and outgoing IDs remained unique. Test fault injection additionally verified lost acknowledgement after an adapter send, persisted SENDING recovery, duplicate receipts, late/mismatched refunds, concurrent intent idempotency and missing-round recovery.

Real Ark payment testing is **not claimed**. Installed Bark CLI cannot yet satisfy the verified idempotency/reconciliation contract; Second adapter remains fail-closed. See ARK.md.

Final deployed-build recheck at 06:31 UTC: both Playwright scenarios passed against the public host; all HTTP checks returned 200. SSE delivered connected, price_update and heartbeat events. After recreating app and worker, mock transfer count remained exactly **3** (two refunds and one winner payout), with no duplicate sends.

2026-09-09: changed authoritative dashboard polling from five seconds to one second, retaining SSE invalidation and preventing overlapping fetches. Production build passed. Public Chromium tests verify the one-second request cadence even with SSE unavailable, along with desktop/mobile and settlement rendering.

2026-09-09 UI update: prominent Price to beat from the opening median, adjacent orange current price and signed target difference, labeled target line and live-price guide, simplified market header and responsive countdown. Public production build and all three browser scenarios pass, including target-value assertions and one-second refresh fallback. No payment or settlement rules changed.

2026-09-09 chart motion update: default rolling 60-second viewport, latest point near the right edge, requestAnimationFrame transitions for the live point and price scale (650 ms; reduced-motion respected), second-resolution axis, clamped target marker with direction when off scale, and a Full round toggle. Recorded Coinbase observations and settlement inputs remain unchanged; interpolated movement is presentation only. Taller chart and single-column market at widths <=1100px. Production build and all three public browser tests pass, including live-point position, range switching, and one-second refresh. Visually checked the deployed market at 1100px width.

## 2026-09-11: real signet payment authentication

Received 10,000 signet sats in the isolated sender wallet. Real-transfer test against the built Next HTTP server and isolated `btcbet_signet_verify` database passed: signed proposal HTTP 402, unpaid confirmation denied, two 1,000-sat Ark transfers authenticated with private bet reads, repeated confirmations reused sessions, and a 999-sat mismatched payment was denied authentication. Engine generated and the Ark adapter confirmed a 2,000-sat winner payout and 999-sat refund. Sender ended at 10,000 sats; no test sats were lost. Round `1789102200`; oracle samples were deterministic in the isolated database only. Initial staging check found missing CA roots in the Node slim image; Dockerfile now installs ca-certificates.

Pinned CLI history was verified in source to return all movements, superseding the initial CLI-help-based assumption above. Payment mode snapshots prevent mock obligations from consuming real funds. Unit/database tests include signed proof attacks, replay, cutoff, send ambiguity and payment-mode separation.

Public deployment: `GET https://clarionlab.dev/btcbet/api/v1/auth` advertises `btcbet-ark402-v1`, `mode: second`, Second signet, and Keel. A public 402 challenge received an actual 1,000-sat transfer and issued AUTHENTICATED on 2026-09-11 at 04:55:38 UTC. Authenticated GET confirmed ACCEPTED for bet `50bb3c97-9d14-4b47-8491-1cf04fc4569e`, round `1789102500`. All 36 database/unit tests and all three public browser scenarios passed, including one-second chart refresh. Production uses Coinbase observations; no synthetic samples were added.

The public live round completed normally. Its one-sided-pool refund of 1,000 sats was CONFIRMED at 05:00:14 UTC; the bet became REFUNDED without manual settlement. This also verified automatic worker reconciliation and refund after a deployment restart.
