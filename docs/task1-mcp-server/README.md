# Task 1: Stdio MCP server with strict validation

Status: In progress (1.1 transport, 1.2 schemas, 1.3 tools done; field-level error messages land in 1.4)

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

### Trying the tools

The server ships with four mock customers (see [ADR 015](../decisions/015-tool-behavior-mock-data.md)): `CUST-00001` (active, 250.00), `CUST-00002` (active, 0.00), `CUST-00003` (closed, 100.00) and `CUST-00004` (active, 10,000.00). State resets when the process restarts.

To inspect it interactively with the MCP Inspector (fetched on demand, not a project dependency):

```sh
npx @modelcontextprotocol/inspector node --import tsx task1-mcp-server/index.ts
```

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
- **Argument schemas** ([ADR 014](../decisions/014-tool-argument-schemas.md)): strict Zod objects in `src/schemas.ts`; unknown keys are rejected.
  - `customer_id` is `CUST-` followed by exactly 5 ASCII digits, with no trimming.
  - `amount` is a finite number, greater than 0, at most 10,000, with at most 2 decimal places.
  - `reason` is at most 500 characters as sent. Surrounding whitespace and invisible formatting characters (`\p{Default_Ignorable_Code_Point}`) are trimmed, and at least 10 visible characters must remain. Invisible characters inside the text, such as emoji ZWJ sequences or ZWNJ in Persian, are kept but not counted.
  - The JSON Schema for `tools/list` (`src/tool-schemas.ts`, published there in 1.3) is hand-written from the same constants. Behavioral parity tests check that the server is never looser than the published schema.
- **Tools** (`src/tools.ts`, [ADR 015](../decisions/015-tool-behavior-mock-data.md)):
  - Each tool declares its Zod `args` schema, which is required by the `ToolDefinition` type. The server validates through one shared `runTool` before any handler runs, so a tool cannot skip validation. Handlers receive typed, normalized input and read and write an in-memory `CustomerRepository` that stores money as integer cents.
  - Success returns JSON text plus `structuredContent`. Invalid arguments are `-32602`.
  - Business failures (not found, account closed, exceeds balance) are `isError: true` results with fixed messages.
  - Refund logs carry only `customer_id`, `refund_id`, `amount` or a failure code, never the reason text or email.
- **Stdout ownership:** only the transport writes to stdout. The logger writes JSON lines to stderr. ESLint `no-console` (only `console.error` allowed) plus a source scan enforce it.

## Acceptance criteria

| ID    | Criterion                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                             | Met |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| AC1.1 | Runs via `npm run task1`, connects over stdio, completes `initialize` with the SDK `Client`                                            | `e2e.stdio.test.ts` "npm run task1 connects with the SDK client" (real npm launch) and "connects with the SDK client…" (direct launch); `server.test.ts` "completes initialize…"                                                                                                                                                                                                                                                                     | [x] |
| AC1.2 | `tools/list` returns both tools with JSON Schema `inputSchema` (pattern, exclusiveMinimum/maximum, minLength/maxLength, no extra keys) | `server.test.ts` "lists both tools in a result the SDK accepts" (exact list, SDK `ListToolsResultSchema` and `ToolSchema`); `e2e.stdio.test.ts` "lists both tools with their schemas and annotations"; `tool-schemas.test.ts` exact shapes and behavioral parity with Zod                                                                                                                                                                            | [x] |
| AC1.3 | Invalid params return `-32602` with a fixed field-level message; no Zod internals or stack traces                                      | Partial: per-field Zod validation (`schemas.test.ts`: every invalid input fails at exactly its field path; all three paths reported together), envelope-level `-32602` (`inbound.test.ts`), sanitization (`outbound.test.ts`), plain-Error masking (`server.test.ts`). Field-level messages on the wire land in 1.4                                                                                                                                  | [ ] |
| AC1.4 | Unknown tool `-32602`, unknown method `-32601`, malformed JSON `-32700` with `id: null`; server keeps running                          | `server.test.ts` "answers an unknown tool…", "answers an unknown method…"; `inbound.test.ts` "parse errors"; `transport.test.ts` "replies -32700 … keeps reading"; `e2e.stdio.test.ts` "keeps answering after repeated malformed input", "rejects an oversize line and keeps running"                                                                                                                                                                | [x] |
| AC1.5 | Every stdout line of a scripted session parses as JSON-RPC 2.0; logs only on stderr                                                    | `e2e.stdio.test.ts` "writes only JSON-RPC to stdout…", "keeps stdout pure JSON-RPC and logs no refund reason" (real tool calls) and "npm run --silent task1 writes only JSON-RPC to stdout"; `logger.test.ts` "defaults to stderr…"; `hygiene.test.ts` "source never writes to stdout directly"                                                                                                                                                      | [x] |
| AC1.6 | Lint forbids `console.log` / `console.info`                                                                                            | `hygiene.test.ts` "lint rejects …" (log, info, warn) and "lint allows console.error"                                                                                                                                                                                                                                                                                                                                                                 | [x] |
| AC1.7 | Tools return mock data; business failures (not found, account closed, exceeds balance) return `isError: true` results                  | `tools.test.ts` "business failures", "trigger_refund", "get_customer_record"; `customer-repository.test.ts` (cent-exact balances, precedence, ids); `server.test.ts` "returns business failures as isError results…", "returns tool results the SDK accepts", "cannot overdraw with pipelined refunds"; `e2e.stdio.test.ts` "reads a record, refunds, and reads the reduced balance", "reports business failures as isError and bad input as -32602" | [x] |

## Tradeoffs and limitations

- **Owning a transport:** about 200 lines that the SDK would otherwise provide. In exchange, every malformed input gets a spec-correct reply, and memory per line is bounded at 1 MiB.
- **Closed set of error messages:** any message not on the allowlist is replaced with the canonical one. That guarantees no leakage, but new messages must be registered in `src/errors.ts`.
- **Shutdown on stdin end:** the transport closes once every request read before the end has been answered or cancelled (`notifications/cancelled`), so replies to piped requests are never lost. Requests are counted per id, so a client reusing an id still gets every answer.
- **Non-integer ids** such as `1.5`, valid in plain JSON-RPC, are rejected with `id: null`, because MCP ids are strings or integers.
- **JSON Schema is advisory:** it cannot express the 2-decimal rule or visible-length counting. Those are stated in the field descriptions and enforced by Zod. The server is never looser than the published schema, and parity tests check this.
- **Amounts must be exact cents:** `0.1 + 0.2` (0.30000000000000004) is rejected rather than silently rounded, because a refund amount should never be changed on the server.
- **npm banner:** `npm run task1` is for humans. MCP clients must use `--silent` or launch Node directly (see above).
- **In-memory state:** balances and refund ids reset when the server restarts. That is acceptable for a mock, and documented in ADR 015.
- **Refund reason on stdout, not in logs:** the result echoes the normalized reason back to the client, but logs never contain it.

## Sub-task log

| Sub-task                   | What changed                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                         | Verified by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Commit |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.1 Skeleton and transport | Added `LineTransport`, inbound classifier, outbound sanitizer, `RpcError` and fixed messages, stderr JSON logger, low-level `Server` with tool registry, `index.ts`, `task1` / `test:task1` scripts; ADRs 012, 013                                                                                                                                                                                                          | Spike showed the stock transport sends no `-32700` / `-32600`, leaks Zod text for bad `tools/call`, and prefixes `McpError` messages                        | `npm run check`: 195 tests pass. `/code-review` (medium): 10 findings, 9 fixed with regression tests (in-flight tracking per id, cancellation, write failure, CRLF size, shared drain listener, logger shared refs and `cause`, derived allowlist, real npm launch tests); `params: []` kept at `-32600` per approved Q3. `mcp-protocol-reviewer`: FAIL, then fixed: requests failing the SDK message schema were dropped unanswered (now `-32602` via an SDK-schema gate); invalid params on SDK-validated methods returned `-32603` (now pre-validated to `-32602`); id reuse plus late cancellation documented in ADR 013. `spec-reviewer`: PASS; minors fixed (env-file flag on direct launch, pending drain rejected on close, lint probe note, this log entry). Manual `npm run task1` session: npm banner found on stdout, `--silent` gives pure JSON-RPC | —      |
| 1.2 Argument schemas       | Added strict Zod schemas for both tools (`src/schemas.ts`) and hand-written JSON Schema (`src/tool-schemas.ts`); ADR 014                                                                                                                                                                                                                                                                                                    | Spec formats plus agreed bounds: amount at most 10,000 with 2 decimals, reason at most 500 code points with at least 10 visible ones                        | `npm run check`: 374 tests pass. `/code-review` (medium): 10 findings, 9 fixed (edge-only trimming keeps emoji ZWJ and Persian ZWNJ; `p{Default_Ignorable_Code_Point}` replaces a hand list; raw-length maximum matches `maxLength`; behavioral JSON Schema parity tests; ASCII-only sources plus a hygiene guard, which also caught a literal BOM left in a 1.1 test; doc fixes); `0.1 + 0.2` rejection kept by design. `mcp-protocol-reviewer`: PASS (Zod vs Ajv on 25k random values, no case where the server is looser); minors adopted (`[0-9]` instead of `d`, draft-06+ note). `spec-reviewer`: FAIL, then fixed: quadratic trailing-trim regex replaced by a linear scan plus an aborting length check, with a 1 MB regression test; doc wording fixes                                                                                                  | —      |
| 1.3 Tool handlers          | Added `CustomerRepository` with four mock customers (integer cents) and `createTools` with both handlers, annotations and fixed business-failure messages; wired into `index.ts`. `ToolDefinition` now requires a Zod `args` schema, and the server validates every call through a shared `runTool` before the handler runs (`defineTool` keeps handlers typed); CLAUDE.md Task 1 rule updated to match. ADR 015; new AC1.7 | Make the server usable end to end, with business outcomes as `isError` results, protocol errors kept for invalid input, and no tool able to skip validation | `npm run check`: 455 tests pass (82 new). `/code-review` (medium): 10 findings, all fixed (validation centralized in `runTool`; self-contained fresh-state test; real backslash path in the masking test; AC1.5 evidence; shared `withClient` helper; stderr parsing limited to log lines; derived `find()`; one failure-message map; exact response count in the pipelined test). `security-reviewer`: PASS (1,000,000 cent amounts convert exactly; draining to zero exact; no mutation through returned objects; prototype-key ids rejected; no validation bypass; no PII in logs); both lows adopted (strict-args test for every tool, atomicity comment at `refund()`). `spec-reviewer`: PASS; minors fixed (this row, `defineTool` cast comment)                                                                                                           | —      |
