# Task 4: Token rate limiter and model fallback (SQLite)

Status: Done (4.1 to 4.8 implemented in one pass on `task4/main`; see the log below).

## Setup and run

```sh
npm ci
cp .env.example .env          # set PRIMARY_API_KEY and SECONDARY_API_KEY (any value for the stubs)
npm run task4:providers       # stub providers on 127.0.0.1:8101 (primary) and 8102 (secondary)
npm run task4                 # router on 127.0.0.1:8100
npm run test:task4
```

The router reads the tenant key from `Authorization: Bearer <key>` and counts tokens against that key's window. The database file is `SQLITE_PATH` (default `data/rate-limit.db`, created when missing; ignored by git).

## Design

```
client ── POST /v1/completions ──► router
                                     │ 1. auth: Bearer key → SHA-256 tenant hash
                                     │ 2. validate body (strict schema, 64 KB max)
                                     │ 3. reserve: BEGIN IMMEDIATE; evict; sum window; insert estimate
                                     │      over the limit → 429 + Retry-After; larger than the whole limit → 400 (no provider called)
                                     ▼
                    primary ──(429 · 5xx · timeout · network)──► secondary
                       │ ok                                          │ ok
                       ▼                                             ▼
          settle reservation to reported usage      settle reservation; both failed → release
                       │
                       ▼
             200 with the provider body
```

- **Window:** token-aware and sliding. A row counts while `ts > now - windowMs`. Rows older than that are deleted on each check. See [ADR 026](../decisions/026-token-window-sqlite-limiter.md).
- **Storage:** `usage(id, tenant_hash, ts, tokens, status)`, indexed on `(tenant_hash, ts)`. WAL mode, `busy_timeout` 5 s. Keys stored only as SHA-256 hex.
- **Estimate:** `ceil(prompt characters / 4) + max_tokens`, reconciled with the provider's `usage.total_tokens`.
- **Failover and errors:** see [ADR 027](../decisions/027-provider-failover-and-error-model.md). Other 4xx responses are not failed over.
- **Injection:** clock, database and provider clients are constructor arguments, so every test controls them.

## Acceptance criteria

- [x] **AC4.1** Sliding window per tenant key, default 50,000 tokens per 60 s, configurable. Exactly at the limit passes; one over is 429 `RATE_LIMITED` with `Retry-After` from the oldest rows. Evidence: `window.test.ts` (boundaries, retry math), `limiter.test.ts` "admits a request that lands exactly on the limit"; a cost above the whole limit is refused with 400 (`router.test.ts` "refuses a request larger than the whole limit without calling a provider"), "refuses one token over the limit with a Retry-After in seconds", "frees the window as rows age out", `server.test.ts` "answers 429 with Retry-After and the fixed error shape", "admits a request that lands exactly on the limit".
- [x] **AC4.2** State in an on-disk SQLite file at `SQLITE_PATH`, WAL mode, directory created, expired rows evicted on each check. Evidence: `limiter.test.ts` "uses WAL mode and creates the directory for an on-disk path", "evicts expired rows from the table on each check".
- [x] **AC4.3** Failover on 429, timeout, network error or 5xx; the 3000 ms timeout is enforced; late answers are ignored (never served as ok); other 4xx do not fail over. Late answers: `providers.test.ts` "ignores a late answer: the call settles as a timeout, never as ok". The default: `server.test.ts` "real default timeout (slow)" reads the 3000 ms from `parseRouterConfig`, and `config-and-e2e.test.ts` "applies the defaults" asserts it. Evidence: `providers.test.ts` (each outcome, timeout close to the deadline), `router.test.ts` "fails over to the secondary on…", "does not fail over on a primary rejection…", `server.test.ts` "fails over when the primary never answers within its timeout", and "real default timeout (slow)" (default 3000 ms).
- [x] **AC4.4** Errors are `{"error":{"code","message","request_id"}}` with fixed messages; no upstream body, stack, URL or path; full detail only in the log. Evidence: `server.test.ts` "answers UPSTREAM_UNAVAILABLE with a clean body when both providers fail", "answers UPSTREAM_REJECTED…", "logs the failure detail with the request id…"; `providers.test.ts` "never logs the provider key, the upstream body or the URL".
- [x] **AC4.5** The reservation is reconciled with the reported usage; released when both providers fail or the primary rejects. Evidence: `limiter.test.ts` "replaces the estimate with the reported usage", "frees the reservation when no provider served the request"; `router.test.ts` "serves from the primary and settles…", "answers UPSTREAM_UNAVAILABLE when both providers fail, and releases…".
- [x] **AC4.6** Two connections race for the last tokens and exactly one wins. Evidence: `limiter.test.ts` "lets exactly the tokens in the limit through when two processes race" (two child processes, one database file, limit 1000, cost 100, expects exactly 10 grants).

Additional evidence:

- Keys are stored only as digests: `limiter.test.ts` "stores only the tenant hash, never the raw key"; `tenant.test.ts`.
- Strict request schema: unknown fields, fractional or out-of-range `max_tokens`, empty prompts and bodies over 64 KB are refused before any provider is called (`server.test.ts` "request validation and auth").
- Startup validation names only the failing settings (`config-and-e2e.test.ts`), and the spawned entry starts, serves a request and keeps secrets out of its logs.

## Tradeoffs

| Choice                                  | Benefit                             | Cost                                                                                        |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Token estimate `chars/4 + max_tokens`   | Conservative, known before the call | Over-counts short answers until reconciled                                                  |
| Sliding window (not fixed)              | No burst at a window boundary       | One row per request in the window                                                           |
| `BEGIN IMMEDIATE` for check and reserve | Correct across processes            | Writers serialize; fine at this scale                                                       |
| SHA-256 without a salt                  | As specified; no secret to manage   | An attacker who reads the database could guess short keys; the mitigation is generated keys |
| Per-provider timeout                    | Simple and predictable              | A failed chain can take two timeouts (6 s by default)                                       |
| Failover only on retryable outcomes     | No wasted quota on a bad request    | A provider that returns a misleading 4xx is not retried elsewhere                           |
| Retry-After from the oldest rows        | Accurate for the window             | An estimate: a concurrent request can take the room first                                   |

## Known limits

- **Key rotation is not a quota boundary.** Any well-formed Bearer string gets its own window, so a client can rotate keys to get fresh windows. Preventing this needs a provisioned key set, which the plan does not include. This is an open decision for the owner (see ADR 026).
- **A crash mid-call leaves its reservation in place** until its TTL (both provider timeouts plus 5 s) passes; there is no lease or startup sweep.
- The estimate is rough for non-English text and for prompts with long tokens; reconciliation corrects the record after the call, not the decision before it.
- Limits are per router deployment's database; several routers sharing one file share the limit, but a remote database is out of scope.
- Keys are not validated against an account store, which is the rotation limit above.

## Sub-task log

| Sub-task                                | Changed                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                               | Verified                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 4.1 DB module, schema, path             | `src/db.ts`, `src/tenant.ts`                                                        | WAL, busy timeout, schema, hashed keys                                                                                                                                                                                                                                                                                                                                                                            | `limiter.test.ts`, `tenant.test.ts`                                        |
| 4.2 Window math                         | `src/window.ts`                                                                     | Pure window, usage and Retry-After functions                                                                                                                                                                                                                                                                                                                                                                      | `window.test.ts`                                                           |
| 4.3 Atomic check and reserve            | `src/limiter.ts`                                                                    | Immediate transaction; evict; sum; insert                                                                                                                                                                                                                                                                                                                                                                         | `limiter.test.ts` (including the two-process race)                         |
| 4.4 Provider clients, timeout, failover | `src/providers.ts`, `src/router.ts`, ADR 027                                        | Outcome model; failover only on retryable outcomes                                                                                                                                                                                                                                                                                                                                                                | `providers.test.ts`, `router.test.ts`                                      |
| 4.5 Error sanitization                  | `src/errors.ts`, `src/server.ts`                                                    | Fixed messages; request ids; log-only detail                                                                                                                                                                                                                                                                                                                                                                      | `server.test.ts`, `providers.test.ts`                                      |
| 4.6 Reconciliation and release          | `src/limiter.ts`, `src/router.ts`                                                   | Settle to reported usage; release on failure                                                                                                                                                                                                                                                                                                                                                                      | `limiter.test.ts`, `router.test.ts`                                        |
| 4.7 HTTP endpoint and stubs             | `src/server.ts`, `src/request.ts`, `src/config.ts`, `index.ts`, `stub-providers/`   | Endpoint, validation, config, runnable stubs with behaviors                                                                                                                                                                                                                                                                                                                                                       | `server.test.ts`, `config-and-e2e.test.ts`                                 |
| Review fixes                            | `src/limiter.ts`, `src/router.ts`, `src/server.ts`, `src/providers.ts`, `src/db.ts` | Global eviction and an index on ts; SQL SUM on reserve; a request above the whole limit gets 400, not a wait; a 1 MiB cap on provider bodies; oversize uploads are read and discarded so the 413 arrives; server header and request timeouts; close waits for in-flight requests; the request id appears in the response and the log; reservations are released on unexpected errors; unused `usedTokens` removed | `limiter.test.ts`, `router.test.ts`, `providers.test.ts`, `server.test.ts` |
| 4.8 Docs                                | this file, ADR 026, ADR 027, `.env.example`, root README                            | Record the decisions and the limits                                                                                                                                                                                                                                                                                                                                                                               | —                                                                          |

Defects found while testing and fixed: the router first returned an empty body on success (caught by the design, fixed before testing); the stub reported fixed usage, which masked the limit, so it now reports the requested output; a Windows file lock stopped the e2e cleanup, so cleanup now waits for the child to exit.

---

## Manual testing guide

Run from Git Bash in the repo root. Set `PRIMARY_API_KEY` and `SECONDARY_API_KEY` in `.env` first (any value works with the stubs).

**1. Start the services**

- Terminal 1: `npm run task4:providers`
- Terminal 2: `npm run task4`. Look for a `listening` line with `"service":"task4-rate-limit-router"`. Stdout stays empty.

**2. Set up Terminal 3**

```sh
R=http://127.0.0.1:8100/v1/completions
T='Authorization: Bearer tenant-manual-key-0123456789'
H='content-type: application/json'
```

**3. Checks**

| #   | Command                                                                                                                                                                         | Expected                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `curl -s -X POST $R -H "$T" -H "$H" -d '{"prompt":"hello","max_tokens":10}'`                                                                                                    | 200, JSON with `"text":"stub answer"`                                                                                    |
| 2   | Same, with no `$T` header                                                                                                                                                       | 401, `{"error":{"code":"UNAUTHORIZED",...}}`                                                                             |
| 3   | Same, with `-H "Authorization: Basic abc"`                                                                                                                                      | 401                                                                                                                      |
| 4   | `curl -s -X POST $R -H "$T" -H "$H" -d '{"prompt":"hello","max_tokens":10,"temperature":0}'`                                                                                    | 400 `INVALID_REQUEST` (unknown field)                                                                                    |
| 5   | `curl -s -X POST $R -H "$T" -H "$H" -d '{"prompt":"hello","max_tokens":99999}'`                                                                                                 | 400 `INVALID_REQUEST`                                                                                                    |
| 6   | `curl -s -i -X POST $R -H "$T" -H "$H" -d '{nope'`                                                                                                                              | 400                                                                                                                      |
| 7   | `curl -s -i -X GET $R -H "$T"`                                                                                                                                                  | 405                                                                                                                      |
| 8   | Quota: send check 1 repeatedly until the window fills. With `RATE_LIMIT_TOKENS=50000` this takes many calls; for a quick run, set `RATE_LIMIT_TOKENS=30` and restart Terminal 2 | After a few calls: 429 with a `retry-after` header and `RATE_LIMITED` in the body                                        |
| 9   | Wait the `retry-after` seconds, then repeat check 1                                                                                                                             | 200 again (the window slid)                                                                                              |
| 10  | Set `STUB_PRIMARY_MODE=429` (restart Terminal 1 with it set), then check 1                                                                                                      | 200 served by the secondary (the primary stub logs nothing; check the router log for `primary failed, trying secondary`) |
| 11  | Restart Terminal 1 with `STUB_PRIMARY_MODE=hang` and `PRIMARY_TIMEOUT_MS=500` in `.env`, then check 1                                                                           | 200, after about half a second (failover on timeout)                                                                     |
| 12  | Restart Terminal 1 with `STUB_PRIMARY_MODE=400`, then check 1                                                                                                                   | 502 `UPSTREAM_REJECTED`; no secondary call                                                                               |
| 13  | Restart Terminal 1 with `STUB_PRIMARY_MODE=500` and `STUB_SECONDARY_MODE=500`, then check 1                                                                                     | 502 `UPSTREAM_UNAVAILABLE`; the body contains no URL, port or stack                                                      |
| 14  | Stop both providers (Terminal 1, Ctrl+C), then check 1                                                                                                                          | 502 `UPSTREAM_UNAVAILABLE`; the router stays up (repeat check 1 after restarting the providers: 200)                     |

**4. Database:** `data/rate-limit.db` is a SQLite file in WAL mode. Inspect it with `sqlite3 data/rate-limit.db "select tenant_hash, tokens, status from usage"` (if `sqlite3` is installed). Tenant keys appear only as 64-character hex digests.

**5. Logs:** Terminal 2 shows one `request` line per call, and the failure lines carry a `request_id` that matches the `x-request-id` header. Keys and prompts never appear.

**6. Not coverable by hand:** exact boundary arithmetic, the two-process race, and the timeout boundary. Run `npm run test:task4` for these.
