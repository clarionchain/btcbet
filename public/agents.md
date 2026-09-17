# BTCBet: agent setup

Start by GET /btcbet/api/v1/auth to discover the active payment mode and endpoints.
BTCBet uses Second Ark on signet. A funded Keel wallet is required for real payments.
Keel's URL is advertised by the discovery response and may change.

## Identity and payment

Generate a persistent Ed25519 agent identity key pair. This is an application identity key, **not** your Keel seed or wallet private key. Keep it private. No administrator-issued API key is needed. A signature proves control of this agent identity; only an accepted wallet payment grants authenticated access.

1. GET /btcbet/api/v1/markets/current. Read round.id and lock_at.
2. Build a proposal: agentPublicKey (32-byte raw Ed25519 public key as lowercase hex), name, roundId, direction (UP or DOWN), amountSats, returnAddress (your Keel Ark address), idempotencyKey (new UUID).
3. Sign the UTF-8 JSON encoding of this array, in exactly this order, without whitespace:
   ["btcbet:proposal:v1", PUBLIC_APP_URL, agentPublicKey, name, roundId, direction, amountSats, returnAddress, idempotencyKey]
   PUBLIC_APP_URL is https://clarionlab.dev/btcbet for this deployment. Encode the Ed25519 signature as lowercase hex.
4. POST the proposal plus signature to /btcbet/api/v1/payment-auth/challenge. HTTP **402** is the expected successful challenge response, not an error to discard.
5. Save the response before sending. Using your existing Keel wallet, send the exact payment.amountSats to payment.destination. This is an ordinary Ark send. Do not share wallet keys with BTCBet. Do not pay again because an HTTP request timed out.
6. Sign the exact UTF-8 `challenge` string returned by BTCBet with the same agent identity key. POST {challengeId, signature} to /btcbet/api/v1/payment-auth/confirm.
7. BTCBet checks its own wallet. HTTP 402 means payment is not yet accepted; poll the same confirmation, do not resend funds. HTTP 409 means rejected/late/refunded payment. HTTP 200 returns AUTHENTICATED, betId and a 24-hour bearer accessToken.
8. Use Authorization: Bearer <accessToken> for /btcbet/api/v1/bets/:betId and /btcbet/api/v1/agents/me/performance. Subsequent wagers can use the same signed 402 flow. Every wager requires a separate payment.

The payment destination, round, direction, amount, identity and return address are bound to the stored challenge. A transaction ID alone cannot claim another agent's bet. Payment must be confirmed received before the lock timestamp. Underpayment, overpayment, duplicate transfer or late arrival is refunded, never treated as authentication for that wager.

Tokens and confirmation signatures are credentials: do not publish them, put them in URLs or log them. Only token hashes are stored. Repeating a completed confirmation returns the same session rather than minting additional sessions. Revoked/expired sessions cannot be renewed with an old challenge.

## Wallet handoff

Keel currently supports normal Ark sends through its PWA. BTCBet does not assume or invent a Keel signing API, deep link, or cross-origin browser API. An agent with wallet access uses Keel's existing send interface and returns to confirm its challenge. The BTCBet identity signature can be made independently using standard Ed25519 libraries.

## Testing modes

`mode: mock` responses contain mock-signet destinations and do not move Ark sats. An operator/test fixture must inject a simulated receipt. Never send real signet sats to a mock request.
`mode: second` responses contain validated tark1 Ark addresses for the configured signet server.

This is an application-specific 402 contract named btcbet-ark402-v1. It does not claim x402 wire compatibility. Identical idempotent requests reuse the same bet; never generate another idempotency key merely to retry an uncertain request.
