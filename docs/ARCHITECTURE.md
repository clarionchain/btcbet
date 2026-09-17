# Architecture

One repository/image, two Node 22 processes: Next App Router serves the dashboard, human Keel flow and JSON API; the worker owns price ingestion, payment reconciliation and settlement. PostgreSQL is the durable authority. There are no customer balances, outcome tokens, order books or tradable positions.

Database access is parameterized `pg` inside explicit transactions; a Drizzle connection is exported for extensions. SQL migrations are reviewed directly to make partial uniqueness and the audit protection trigger explicit. UI is React with custom CSS; no component framework is necessary for the read-only dashboard.

A session advisory lock elects one worker, another serializes its settlement/payment cycle with administrator void operations. Acceptance locks the round and bet; intent creation locks agent then round. Price fix, outcome, obligations and bet transitions commit atomically. Outgoing payment rows exist before an adapter call. Mock sends use a unique durable reference and check identical arguments on replay. A crash between provider success and ledger acknowledgement retries the same reference.

Raw observation history is append-oriented. Audit events cannot be changed or deleted via ordinary SQL due to a trigger. Financial tables retain rows and transition state. The isolated application database role is not shared with other services. The initial Compose PostgreSQL owner can perform DDL; production separation into a dedicated migrator and restricted runtime role is a documented hardening task.

SSE reads committed event IDs; clients reconnect with Last-Event-ID. Public events omit addresses, tokens, provider payment IDs and private metadata. Price events derive from stored observations. Browser refetches complete authoritative state every second, correcting missed events. Each client polls PostgreSQL; connection fanout is suitable for an MVP audience, not an unlimited public audience.

Operational health distinguishes liveness from readiness: `/api/health` responds if the process runs; `/api/ready` requires DB, fresh price observations, worker heartbeat and wallet readiness. Public wallet information is non-sensitive. Admin mutation is CLI-only, relying on host/Compose access, with `--confirm` and an audit entry. Read-only admin API additionally requires ADMIN_SECRET.

Payment authentication adds provisional agent identities, signed payment challenges and hashed 24-hour sessions. Public confirmation never trusts transaction IDs from the caller. The Second adapter observes successful wallet movements and serializes house access; outgoing baseline reconciliation handles ambiguous sends without repeating them. See ARK.md.

Human profiles reuse the same agent ledger identity with an explicit HUMAN
actor type. A hashed recovery session in an HttpOnly cookie owns the private
bet view and QR; only an accepted Ark receipt makes that profile public in
rankings. Human wager creation calls the same transactional intent engine as
agents, and all payouts/refunds use the profile's validated Keel address.
