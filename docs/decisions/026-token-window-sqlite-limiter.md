# 026: Token-aware sliding window limiter on SQLite

- Status: Accepted
- Source: [Spec] (token-aware sliding window per tenant key, 50,000 tokens per 60 s by default, SQLite with WAL and timestamped rows, SHA-256 hashed keys, eviction on each check, check-and-reserve in an immediate transaction, injected clock, database and providers) + [Decided] (estimate formula, reconciliation, window boundary, multi-process test method)

## Context

A rate limit is only as good as its state. The limiter must count tokens, not requests; survive several router processes sharing one file; never store a raw tenant key; and let tests control time. The router is synchronous at the database boundary, so the risk is not in-process concurrency but two processes checking the same window at once.

## Decision

- **Window.** A row counts while `ts > now - windowMs`, so a row exactly one window old has aged out. The window is `(now - windowMs, now]`. `usedTokens` and `retryAfterMs` are pure functions in `src/window.ts`.
- **Estimate.** `ceil(prompt characters / 4) + max_tokens`. The reservation is recorded with this estimate, which is conservative because `max_tokens` is an upper bound on output.
- **Reconciliation.** After a provider serves the request, the row's tokens become the reported `usage.total_tokens`. Without usage in the reply, the estimate stands. A released reservation (no provider served the request) is deleted.
- **Check and reserve.** Eviction, the sum, the check and the insert run in one `BEGIN IMMEDIATE` transaction (`db.transaction(...).immediate`). The write lock is taken before the sum is read, so two connections cannot both see the last tokens as free.
- **Storage.** `usage(id, tenant_hash, ts, tokens, status)` with an index on `(tenant_hash, ts)`. WAL mode, `busy_timeout` of 5 s, and the directory of `SQLITE_PATH` is created if missing.
- **Keys.** Tenant keys are stored as SHA-256 hex. A raw key never reaches the database, the logs, or an error body.
- **Retry-After.** The time until the first departure that frees enough room for the cost, rounded up to whole seconds, at least 1. A cost that cannot fit even in an empty window returns the full window.
- **Open reservations.** A reservation counts until its own TTL, which is the sum of both provider timeouts plus 5 s, rather than the window. Settled usage ages out with the window. This keeps a slow provider from having its tokens evicted while its call is still running, even when the window is shorter than the timeouts.
- **Clock.** Injected (`Clock.now()`), so tests run with a fixed clock and the production path uses `Date.now()`.

## Alternatives considered

- **Fixed windows** (reset every 60 s): simpler, but allow double the limit across a boundary. Rejected.
- **In-memory counters:** fast and simple, but not shared across processes and lost on restart. Rejected by the spec's SQLite requirement.
- **Counting requests instead of tokens:** does not match the spec or the cost of a request. Rejected.
- **Deferred locking (`BEGIN` instead of `BEGIN IMMEDIATE`):** two readers can both pass the check, then both write. Rejected.
- **Hashing with a salt or HMAC:** would stop offline guessing of short keys, but needs a secret to manage. SHA-256 is what the spec names; the mitigation is that keys are generated, not chosen. Noted as a tradeoff.

## Consequences

- Two processes racing for the last tokens grant exactly the limit (tested with two real child processes on one database file).
- Eviction runs for every key on each check (indexed on ts), so rows of keys that never return are removed too. The sum is computed in SQL; rows are read only to work out a Retry-After on refusal.
- **Open decision (owner):** any well-formed Bearer string is its own tenant, so key rotation resets the quota. A provisioned key set would close this; the plan does not include one.
- Retry-After is an estimate of when the next reservation fits, not a promise.
