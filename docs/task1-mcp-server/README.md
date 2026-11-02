# Task 1: Stdio MCP server with strict validation

Status: In progress (1.1 done: skeleton, transport, error handling; tools land in 1.2-1.3)

## Setup and run

```sh
npm install
npm run task1          # starts the server on stdio; logs go to stderr
npm run test:task1     # unit, integration and spawned-process tests
```

`LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) controls stderr logging.

### Connecting an MCP client

`npm run task1` prints npm's script banner to stdout, so MCP clients should launch the server without it:

```json
{
  "mcpServers": {
    "quilr-customer": {
      "command": "node",
      "args": ["--env-file-if-exists=.env", "--import", "tsx", "task1-mcp-server/index.ts"],
      "cwd": "/path/to/quilr-assessment"
    }
  }
}
```

`npm run --silent task1` is equivalent. Both were verified to produce pure JSON-RPC on stdout.

## Design

```
stdin bytes ─► LineTransport ─► classifyInbound ─┬─ message ─► SDK Server ─► tool registry
                (framing,                        ├─ reply ───► -32700 / -32600 / -32602
                 1 MiB cap)                      └─ drop  ───► (invalid notification/response)
stdout ◄─ one JSON line ◄─ sanitizeOutbound ◄── responses and errors
stderr ◄─ createLogger (JSON lines)
```

- **Low-level SDK `Server`** ([ADR 012](../decisions/012-low-level-server-rpc-errors.md)): handlers throw `RpcError` with a numeric code and an exact message. `McpServer` would turn invalid input into `isError` results, and `McpError` prefixes messages.
- **Custom `LineTransport`** ([ADR 013](../decisions/013-custom-line-transport.md)): the stock stdio transport never replies to malformed input and closes on oversize input.
- **Inbound classification** (`src/inbound.ts`): a pure function per line.
  - Malformed JSON gets `-32700` with `id: null`.
  - An invalid envelope or a batch gets `-32600`, with the id echoed only when it is a valid MCP id (string or safe integer).
  - Invalid params get `-32602 "Invalid params"`. Every message must also pass the SDK's own `JSONRPCMessageSchema`, and `initialize`, `ping`, `tools/list` and `tools/call` are checked against the SDK request schemas first. Otherwise the SDK would drop the request unanswered (for example a non-object `params._meta`), answer `-32603`, or leak Zod text.
  - Invalid notifications and responses are dropped silently.
- **Outbound sanitization** (`src/outbound.ts`): error messages are checked against a per-code allowlist. Unknown codes become `-32603`, the SDK prefix is removed, and `data` is dropped.
- **Stdout ownership:** only the transport writes to stdout. The logger writes JSON lines to stderr. ESLint `no-console` (only `console.error` allowed) plus a source scan enforce it.

## Acceptance criteria

| ID    | Criterion                                                                                                     | Evidence                                                                                                                                                                                                                                                                              | Met |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| AC1.1 | Runs via `npm run task1`, connects over stdio, completes `initialize` with the SDK `Client`                   | `e2e.stdio.test.ts` "npm run task1 connects with the SDK client" (real npm launch) and "connects with the SDK client…" (direct launch); `server.test.ts` "completes initialize…"                                                                                                      | [x] |
| AC1.2 | `tools/list` returns both tools with JSON Schema `inputSchema` (pattern, minimum, minLength, no extra keys)   | Partial: empty `tools/list` verified (`server.test.ts` "lists no tools…"). Tools land in 1.2-1.3                                                                                                                                                                                      | [ ] |
| AC1.3 | Invalid params return `-32602` with a fixed field-level message; no Zod internals or stack traces             | Partial: envelope-level `-32602 "Invalid params"` (`inbound.test.ts` "tools/call params"), sanitization (`outbound.test.ts`), plain-Error masking (`server.test.ts` "hides a plain Error…"). Field-level messages land in 1.4                                                         | [ ] |
| AC1.4 | Unknown tool `-32602`, unknown method `-32601`, malformed JSON `-32700` with `id: null`; server keeps running | `server.test.ts` "answers an unknown tool…", "answers an unknown method…"; `inbound.test.ts` "parse errors"; `transport.test.ts` "replies -32700 … keeps reading"; `e2e.stdio.test.ts` "keeps answering after repeated malformed input", "rejects an oversize line and keeps running" | [x] |
| AC1.5 | Every stdout line of a scripted session parses as JSON-RPC 2.0; logs only on stderr                           | `e2e.stdio.test.ts` "writes only JSON-RPC to stdout…" (re-run with real tools in 1.5) and "npm run --silent task1 writes only JSON-RPC to stdout"; `logger.test.ts` "defaults to stderr…"; `hygiene.test.ts` "source never writes to stdout directly"                                 | [x] |
| AC1.6 | Lint forbids `console.log` / `console.info`                                                                   | `hygiene.test.ts` "lint rejects …" (log, info, warn) and "lint allows console.error"                                                                                                                                                                                                  | [x] |

## Tradeoffs and limitations

- **Owning a transport:** about 200 lines that the SDK would otherwise provide. In exchange, every malformed input gets a spec-correct reply, and memory per line is bounded at 1 MiB.
- **Closed set of error messages:** any message not on the allowlist is replaced with the canonical one. That guarantees no leakage, but new messages must be registered in `src/errors.ts`.
- **Shutdown on stdin end:** the transport closes once every request read before the end has been answered or cancelled (`notifications/cancelled`), so replies to piped requests are never lost. Requests are counted per id, so a client reusing an id still gets every answer.
- **Non-integer ids** such as `1.5`, valid in plain JSON-RPC, are rejected with `id: null`, because MCP ids are strings or integers.
- **npm banner:** `npm run task1` is for humans. MCP clients must use `--silent` or launch Node directly (see above).

## Sub-task log

| Sub-task                   | What changed                                                                                                                                                                                                       | Why                                                                                                                                  | Verified by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Commit |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.1 Skeleton and transport | Added `LineTransport`, inbound classifier, outbound sanitizer, `RpcError` and fixed messages, stderr JSON logger, low-level `Server` with tool registry, `index.ts`, `task1` / `test:task1` scripts; ADRs 012, 013 | Spike showed the stock transport sends no `-32700` / `-32600`, leaks Zod text for bad `tools/call`, and prefixes `McpError` messages | `npm run check`: 195 tests pass. `/code-review` (medium): 10 findings, 9 fixed with regression tests (in-flight tracking per id, cancellation, write failure, CRLF size, shared drain listener, logger shared refs and `cause`, derived allowlist, real npm launch tests); `params: []` kept at `-32600` per approved Q3. `mcp-protocol-reviewer`: FAIL, then fixed: requests failing the SDK message schema were dropped unanswered (now `-32602` via an SDK-schema gate); invalid params on SDK-validated methods returned `-32603` (now pre-validated to `-32602`); id reuse plus late cancellation documented in ADR 013. `spec-reviewer`: PASS; minors fixed (env-file flag on direct launch, pending drain rejected on close, lint probe note, this log entry). Manual `npm run task1` session: npm banner found on stdout, `--silent` gives pure JSON-RPC | —      |
