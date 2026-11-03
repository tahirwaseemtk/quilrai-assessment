# Task 2: MCP security gateway (auth + tool filtering)

Status: In progress (2.1 mock downstream, 2.2 client auth, 2.3 envelope validation done)

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
- **Bearer parsing** (`src/bearer.ts`): exactly `<scheme> <token>`, with a case-insensitive scheme, RFC 6750 `token68` token characters, and a constant-time comparison over SHA-256 digests. It is shared by the mock and the gateway.
- **Client auth** ([ADR 019](../decisions/019-gateway-client-auth.md)):
  - `GATEWAY_TOKENS` maps tokens to `admin` or `viewer` and is parsed by `src/token-config.ts`. Only SHA-256 digests are kept, and bad config fails with fixed reasons. Placeholder or short tokens are accepted with a warning, logged at startup from 2.4.
  - `authenticate` (`src/auth.ts`) takes only the `headersDistinct` shape, refuses duplicate `Authorization` headers, and compares against every configured token in constant time, with no early exit.
- **Envelope classification** ([ADR 020](../decisions/020-gateway-envelope-classification.md)): `classifyBody` (`src/envelope.ts`) answers malformed input itself, using the envelope checks shared with Task 1 (`shared/`).
  - Malformed JSON gets `-32700`; an invalid envelope, any batch, **any duplicated key** (compared case- and Unicode-folded) or a `tools/call` lookalike method gets `-32600`; an SDK-invalid request or a `tools/call` without a string `name` or with bad `arguments` gets `-32602`.
  - `tools/call` is its own `tool-call` kind with a required tool name, read from the raw own property. Every `tools/call` notification is dropped, as are invalid notifications and responses.
  - Refusing duplicate keys removes parser ambiguity, so bodies are forwarded byte-for-byte.
- **Logging:** the shared stderr logger ([ADR 017](../decisions/017-shared-logger-service-tagging.md)), tagged `task2-mcp-gateway` or `mock-downstream`.

## Acceptance criteria

| ID    | Criterion                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                          | Met |
| ----- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| AC2.1 | Bearer token mapped to role via config; missing, malformed, or unknown token returns HTTP 401 with `WWW-Authenticate` | Partial: `auth.test.ts` (roles, missing / malformed / duplicate / unknown, every entry compared), `token-config.test.ts` (config validation, digest-only storage). The HTTP 401 with `WWW-Authenticate` lands with the HTTP layer in 2.4                                                                                          | [ ] |
| AC2.2 | `tools/list` forwarded unchanged; downstream response streamed back                                                   |                                                                                                                                                                                                                                                                                                                                   | [ ] |
| AC2.3 | Non-admin calling `admin` / `admin_*` gets `-32001` "Unauthorized Tool Call"; downstream receives zero calls          |                                                                                                                                                                                                                                                                                                                                   | [ ] |
| AC2.4 | Malformed JSON `-32700`; invalid envelope or batch `-32600`; bad `params.name` `-32602`                               | Partial: `envelope.test.ts` (malformed JSON → `-32700`; non-objects, bad envelopes, every batch and duplicated keys → `-32600`; SDK-invalid requests and bad `tools/call` params → `-32602`; ids echoed; no Zod text), `rpc-errors.test.ts`, `shared/test/*`. The tool-name pattern lands in 2.5 and the HTTP status codes in 2.4 | [ ] |
| AC2.5 | Downstream failure returns sanitized `-32603` with HTTP 502                                                           |                                                                                                                                                                                                                                                                                                                                   | [ ] |

## Tradeoffs and limitations

- **The SDK HTTP transport answers some malformed input differently from what the gateway must return.** For example, valid JSON that is not JSON-RPC gets `-32700`, not `-32600`. The gateway therefore classifies envelopes itself (2.3) instead of relying on the downstream. The pinned SDK behavior is listed in ADR 018.

## Carried forward to 2.2 (resolved)

All four items from the 2.1 security review are handled in 2.2 (ADR 019):

- Constant-time comparison against every configured token: `authenticate`, with no early exit.
- More than one `Authorization` header is refused (`duplicate`).
- Credential-named fields are redacted by the shared logger (ADR 017).
- Placeholder or short tokens are accepted; `parseTokenConfig` returns a warning, which the 2.4 entry point logs at startup (owner decision).

## Carried forward to 2.4

From the 2.2 security review and from sub-task 2.3 (ADR 020), for the gateway entry point and HTTP layer:

- Log the `parseTokenConfig` warning at startup. Short tokens with unthrottled 401s could be brute-forced, so the warning must be visible.
- Delete `process.env.GATEWAY_TOKENS` after a successful parse, so spawned processes and environment dumps no longer hold the raw tokens.
- Forward bodies byte-for-byte with the one accepted leading BOM stripped; duplicate keys are already refused (ADR 020).
- Answer a duplicate-key `-32600` with HTTP 400 even when the body was shaped like a notification or response.
- Decode bodies as strict UTF-8 (invalid bytes give `-32700`), accept only a missing charset or `charset=utf-8`, and send the gateway's own `Content-Type: application/json` downstream.

## Carried forward to 2.5

From the 2.3 security review, for the admin gate:

- Apply the tool-name pattern `^[A-Za-z0-9_.-]{1,128}$` before the admin check; names such as `constructor` or ones with lone surrogates reach the gate unchanged.
- Never look a tool name up on a plain object (`constructor`, `__proto__`).
- Answer `drop` results with HTTP 202 and no body, and forward nothing.

## Sub-task log

| Sub-task                | What changed                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                            | Verified by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Commit |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2.1 Mock downstream     | Added the mock downstream MCP server (`mock-downstream/`: server, config, entry), `src/bearer.ts`, `task2:mock` / `test:task2` scripts and `MOCK_DOWNSTREAM_PORT`; moved the logger to `shared/` with a required `service` tag and a shared `CaptureSink` test helper (Task 1 updated, its hygiene scans now cover `shared/`); ADRs 017, 018                 | Test infrastructure for AC2.2, AC2.3, AC2.5 and the no-token-passthrough rule; logs stay attributable per process                                              | `npm run check`: 713 tests pass (Task 2: 113). `/code-review` (medium): 10 findings, all fixed (hygiene scan covers `shared/`; e2e waits for `close`, parses complete lines only and pins `LOG_LEVEL`; listen error listener detached; empty port means default; pinned `-32000`; one `CaptureSink`). `security-reviewer`: PASS; adopted raw-path matching (no 500 on odd targets), `token68` token grammar validated at startup, and a pinned Node whitespace-trimming test; four lows carried forward to 2.2 (below). `spec-reviewer`: PASS; Task 1 AC1.5 evidence path fixed, typed `mockTool` helper                                                                                                                                                                                                                                                | —      |
| 2.2 Client auth         | Added `src/token-config.ts` (`GATEWAY_TOKENS` to a frozen digest table, fixed error reasons, placeholder warning) and `src/auth.ts` (duplicate-header refusal, constant-time comparison over every entry); `tokenDigest` in `src/bearer.ts`; credential redaction in `shared/logger.ts`; ADR 019                                                             | Derive the client role safely; resolve the four items carried forward from the 2.1 security review                                                             | `npm run check`: 919 tests pass. `/code-review` (medium): 10 findings, all fixed (`authenticate` accepts only the `headersDistinct` shape; default comparator asserted to be `timingSafeEqual`; Zod for the config shape; broader placeholder markers; warnings frozen; wider credential keys and `rawHeaders` pairs in the logger). `security-reviewer`: PASS (every entry compared, no echo, digest-only, linear regexes); four lows fixed: `…tokens` keys kept only as numbers, more credential keys plus URL userinfo masking, a never-throw logger fallback, and duplicated tokens rejected; two items carried forward to 2.4 (above). `spec-reviewer`: PASS                                                                                                                                                                                       | —      |
| 2.3 Envelope validation | Moved the generic envelope schemas and decision tree to `shared/jsonrpc-envelope.ts`, standard codes to `shared/jsonrpc-errors.ts`, added `shared/json-duplicate-keys.ts` (Task 1 refactored to use them, behavior unchanged apart from stripping one BOM only); added `src/rpc-errors.ts` and `src/envelope.ts` (`classifyBody`, `tool-call` kind); ADR 020 | The gateway answers malformed input itself (the downstream SDK would answer `-32700` for invalid envelopes) and extracts the tool name safely for the 2.5 gate | `npm run check`: 1174 tests pass (Task 1: 585, including new BOM-rule tests). `/code-review` (medium): 9 findings, all fixed, including two gate bypasses through duplicated `method` keys (duplicate keys now refused at any depth, replacing the planned `tools/call` re-serialization). `mcp-protocol-reviewer`: PASS (Task 1 parity traced branch by branch); stale ADR table removed, notification- and response-shaped duplicate bodies pinned, BOM forwarding and HTTP 400 obligations recorded for 2.4. `security-reviewer`: FAIL, then fixed: keys differing only in case or Unicode form (Go's case-insensitive matching) are now folded before the duplicate check; `tools/call` lookalike methods refused; scanner bounds-checked; strict UTF-8 decoding recorded for 2.4 and name checks for 2.5. `spec-reviewer`: PASS; doc fixes applied | —      |
