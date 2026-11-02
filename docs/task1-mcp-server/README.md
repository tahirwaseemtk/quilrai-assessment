# Task 1: Stdio MCP server with strict validation

Status: Planned

## Setup and run

_Added in sub-task 1.1._

## Design

_Added as sub-tasks land, with links to ADRs._

## Acceptance criteria

| ID    | Criterion                                                                                                     | Evidence | Met |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------- | --- |
| AC1.1 | Runs via `npm run task1`, connects over stdio, completes `initialize` with the SDK `Client`                   |          | [ ] |
| AC1.2 | `tools/list` returns both tools with JSON Schema `inputSchema` (pattern, minimum, minLength, no extra keys)   |          | [ ] |
| AC1.3 | Invalid params return `-32602` with a fixed field-level message; no Zod internals or stack traces             |          | [ ] |
| AC1.4 | Unknown tool `-32602`, unknown method `-32601`, malformed JSON `-32700` with `id: null`; server keeps running |          | [ ] |
| AC1.5 | Every stdout line of a scripted session parses as JSON-RPC 2.0; logs only on stderr                           |          | [ ] |
| AC1.6 | Lint forbids `console.log` / `console.info`                                                                   |          | [ ] |

## Tradeoffs and limitations

_Added as sub-tasks land._

## Sub-task log

| Sub-task | What changed | Why | Verified by | Commit |
| -------- | ------------ | --- | ----------- | ------ |
