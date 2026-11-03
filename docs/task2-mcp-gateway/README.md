# Task 2: MCP security gateway (auth + tool filtering)

Status: In progress (2.1 mock downstream done)

## Setup and run

```sh
npm ci
npm run task2:mock     # mock downstream MCP server on 127.0.0.1:8081 (needs DOWNSTREAM_AUTH_TOKEN)
npm run test:task2
```

The gateway entry point (`npm run task2`) lands in sub-task 2.4.

## Design

- **Mock downstream** ([ADR 018](../decisions/018-mock-downstream-mcp-server.md)): a real SDK MCP server over Streamable HTTP (stateless, JSON responses; SSE optional) at `POST /mcp`.
  - Tools: `get_status`, `admin_reset_key`, `admin`.
  - It accepts only the gateway's downstream credential, so a forwarded client token fails with 401.
  - A call spy records the tools that actually ran, so tests can prove a blocked call never reached it.
- **Bearer parsing** (`src/bearer.ts`): exactly `<scheme> <token>`, with a case-insensitive scheme and a constant-time comparison over SHA-256 digests. It is shared by the mock and the gateway.
- **Logging:** the shared stderr logger ([ADR 017](../decisions/017-shared-logger-service-tagging.md)), tagged `task2-mcp-gateway` or `mock-downstream`.

## Acceptance criteria

| ID    | Criterion                                                                                                             | Evidence | Met |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| AC2.1 | Bearer token mapped to role via config; missing, malformed, or unknown token returns HTTP 401 with `WWW-Authenticate` |          | [ ] |
| AC2.2 | `tools/list` forwarded unchanged; downstream response streamed back                                                   |          | [ ] |
| AC2.3 | Non-admin calling `admin` / `admin_*` gets `-32001` "Unauthorized Tool Call"; downstream receives zero calls          |          | [ ] |
| AC2.4 | Malformed JSON `-32700`; invalid envelope or batch `-32600`; bad `params.name` `-32602`                               |          | [ ] |
| AC2.5 | Downstream failure returns sanitized `-32603` with HTTP 502                                                           |          | [ ] |

## Tradeoffs and limitations

- **The SDK HTTP transport answers some malformed input differently from what the gateway must return.** For example, valid JSON that is not JSON-RPC gets `-32700`, not `-32600`. The gateway therefore classifies envelopes itself (2.3) instead of relying on the downstream. The pinned SDK behavior is listed in ADR 018.

## Sub-task log

| Sub-task            | What changed                                                                                                                                                                                                                            | Why                                                                                                               | Verified by                                                                                                              | Commit |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| 2.1 Mock downstream | Added the mock downstream MCP server (`mock-downstream/`), `src/bearer.ts`, `task2:mock` / `test:task2` scripts and `MOCK_DOWNSTREAM_PORT`; moved the logger to `shared/` with a required `service` tag (Task 1 updated); ADRs 017, 018 | Test infrastructure for AC2.2, AC2.3, AC2.5 and the no-token-passthrough rule; logs stay attributable per process | `npm run check`: 682 tests pass (82 new for Task 2; Task 1 unchanged apart from the logger tag, now asserted end to end) | —      |
