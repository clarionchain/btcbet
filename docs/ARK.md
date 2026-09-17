# Second / Bark / Keel integration

Keel PWA and Android signet connect to `https://ark.signet.2nd.dev`, with Esplora at `https://esplora.signet.2nd.dev`. No Keel files were changed. BTCBet uses a dedicated house wallet, separate from Keel and other services, mounted at `/wallet` in its app and worker.

## Payment authentication

The agent generates an Ed25519 identity key (separate from wallet keys), signs its proposed wager, and requests `/api/v1/payment-auth/challenge`. HTTP 402 supplies a unique house Ark address, exact stake, cutoff, and signed-confirmation message. An ordinary Keel Ark transfer funds the wager. BTCBet issues a 24-hour bearer session only after verifying both the agent signature and an eligible wallet-observed receipt. There is no extra authentication fee. The signature binds the agent identity and return address; it does not prove ownership of a particular Keel wallet.

This is `btcbet-ark402-v1`, a custom HTTP 402 contract over Ark, not standard x402. See [agent instructions](../public/agents.md). No wallet seeds/private keys enter the API, and no pre-issued API key is required. Every wager requires its own payment.

Human users create an anonymous browser profile with a Keel return address.
BTCBet returns HTTP 402 internally when the browser creates a wager, then
displays the unique Ark destination as a QR and the exact amount beside it.
The browser polls using an HttpOnly session cookie; BTCBet accepts the bet only
after its own house wallet observes the payment. Current Keel PWA and Android
parsers scan a plain Ark address and require the amount to be entered separately.
The browser recovery secret is shown once and stored only as a keyed hash.

## Adapter guarantees and limits

Pinned CLI image: `cashu-bark:e3d4174ca08a3c97bc23e1e73aa5332d725a7689`, Bark 0.6.2-dev. The app includes the binary and CA certificates. Official SDK `@secondts/bark` 0.23.0 validates addresses. Startup/readiness checks the configured server and reported signet network.

Source inspection at that revision confirms `history` calls `get_all_movements()` despite its outdated help text about ten entries. A wallet sync returns successful movements with `received_on` destinations and completed timestamps. Incoming receipts use house-wallet completion time, not an agent-supplied send time. Send early enough to be observed before cutoff; a late observation is refunded.

Receive references persist unique derived addresses. All house CLI access is serialized across processes using a PostgreSQL advisory lock. Outgoing operations persist the complete pre-send movement IDs before invoking `send` once. A unique new successful movement matching destination and amount confirms payment. Timeouts and ambiguous outcomes become UNKNOWN; subsequent attempts only reconcile history and never send again. Unresolved operations block new outgoing sends until evidence is recovered. Do not use the house wallet outside this adapter during operation.

Payment mode is snapshotted per round. Real mode cannot fund mock obligations or accept a new wager into a mock round. Historical mock rounds remain in the ledger.

The house wallet is custodial for accepted stakes until payout/refund; BTCBet offers no player deposit balances. Wallet refresh/expiry and backups require operator attention. Agents and humans authorize transfers through Keel; BTCBet never receives Keel wallet keys.
