# Task 4: Token rate limiter + model fallback (SQLite)

Status: Planned

## Setup and run

_Added in sub-task 4.7._

## Design

_Added as sub-tasks land, with links to ADRs._

## Acceptance criteria

| ID    | Criterion                                                                                                          | Evidence | Met |
| ----- | ------------------------------------------------------------------------------------------------------------------ | -------- | --- |
| AC4.1 | Sliding window per tenant (default 50,000 tokens / 60 s); at limit passes, one over returns 429 with `Retry-After` |          | [ ] |
| AC4.2 | Usage stored in on-disk SQLite at `SQLITE_PATH`; rows outside the window evicted on each check                     |          | [ ] |
| AC4.3 | Failover to secondary on 429, 3000 ms timeout, network error, or 5xx; late primary response ignored                |          | [ ] |
| AC4.4 | Errors use `{"error":{"code","message","request_id"}}` with no upstream body, stack, URL, or path                  |          | [ ] |
| AC4.5 | Reservation reconciled with reported usage; released when both providers fail                                      |          | [ ] |
| AC4.6 | Two connections racing for the last tokens: exactly one wins                                                       |          | [ ] |

## Tradeoffs and limitations

_Added as sub-tasks land._

## Sub-task log

| Sub-task | What changed | Why | Verified by | Commit |
| -------- | ------------ | --- | ----------- | ------ |
