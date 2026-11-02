# Task 3: Streaming PII redaction guardrail

Status: Planned

## Setup and run

_Added in sub-task 3.5._

## Design

_Added as sub-tasks land, with links to ADRs._

## Acceptance criteria

| ID    | Criterion                                                                                                    | Evidence | Met |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------- | --- |
| AC3.1 | `POST /v1/chat/completions` with `stream: true` proxies to the provider and re-emits SSE frames and `[DONE]` |          | [ ] |
| AC3.2 | Emails, SSNs, and Luhn-valid card numbers are replaced with `[REDACTED]`                                     |          | [ ] |
| AC3.3 | No PII survives any byte split of the provider stream, including inside multibyte characters                 |          | [ ] |
| AC3.4 | Buffer stays at or below `MAX_HOLDBACK` over a 10 MB stream                                                  |          | [ ] |
| AC3.5 | PII-free prose is emitted with no holdback delay                                                             |          | [ ] |

## Tradeoffs and limitations

_Holdback size vs detection coverage vs latency. Added in sub-task 3.2._

## Sub-task log

| Sub-task | What changed | Why | Verified by | Commit |
| -------- | ------------ | --- | ----------- | ------ |
