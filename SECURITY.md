# Security policy

BTCBet is experimental financial software on Bitcoin Signet. Treat reports that can steal funds, extract keys, or corrupt the ledger as urgent.

## How to report

**Do not open a public GitHub issue** for a vulnerability that could lose bitcoin, expose a house-wallet seed, database contents, or admin secrets.

1. Prefer [GitHub private vulnerability reporting](https://github.com/clarionchain/btcbet/security/advisories/new) on this repository.
2. If that is unavailable, email **dev@clarionchain.io** with a description, affected version/commit, and steps that do **not** include real seeds or mainnet keys.

We will acknowledge reports as soon as practical and keep sensitive details private until a fix is available or the issue is disclosed by agreement.

## Please include

- Git commit
- Whether you hit the public Signet market or a local mock
- Impact (theft, lockout, secret leakage, settlement corruption, and so on)

Never send a real mnemonic, house-wallet directory, `.env`, or production signing key.

## Scope

In scope: BTCBet application code, payment authentication, ledger, and how we integrate Bark.

Out of scope unless BTCBet mishandles them: bugs solely in upstream Bark, the Ark server, Keel, or Coinbase. Please also report those upstream when they belong there.
