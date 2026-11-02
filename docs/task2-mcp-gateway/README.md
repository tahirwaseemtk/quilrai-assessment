# Task 2: MCP security gateway (auth + tool filtering)

Status: Planned

## Setup and run

_Added in sub-task 2.1._

## Design

_Added as sub-tasks land, with links to ADRs._

## Acceptance criteria

| ID    | Criterion                                                                                                             | Evidence | Met |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| AC2.1 | Bearer token mapped to role via config; missing, malformed, or unknown token returns HTTP 401 with `WWW-Authenticate` |          | [ ] |
| AC2.2 | `tools/list` forwarded unchanged; downstream response streamed back                                                   |          | [ ] |
| AC2.3 | Non-admin calling `admin` / `admin_*` gets `-32001` "Unauthorized Tool Call"; downstream receives zero calls          |          | [ ] |
| AC2.4 | Malformed JSON `-32700`; invalid envelope or batch `-32600`; bad `params.name` `-32602`                               |          | [ ] |
| AC2.5 | Downstream failure returns sanitized `-32603` with HTTP 502                                                           |          | [ ] |

## Tradeoffs and limitations

_Added as sub-tasks land._

## Sub-task log

| Sub-task | What changed | Why | Verified by | Commit |
| -------- | ------------ | --- | ----------- | ------ |
