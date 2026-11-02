# 013: Custom stdio line transport

- Status: Accepted
- Source: [Spec] (stdio transport, stdout reserved for JSON-RPC) + [Decided] (custom implementation)

## Context

A spike piped raw lines into the SDK `Server` with the stock `StdioServerTransport` (SDK 1.32.2):

| Input                              | Stock behavior                       |
| ---------------------------------- | ------------------------------------ |
| `{bad json`                        | No response; error only to `onerror` |
| `{"foo":1}` (not JSON-RPC)         | No response                          |
| `tools/call` without `params.name` | `-32603` with the Zod issue dump     |
| Unknown method                     | `-32601 Method not found` (correct)  |

The stock transport also closes itself when its read buffer exceeds 10 MB, which stops the server.

## Decision

`LineTransport` implements the SDK `Transport` interface over injectable `Readable` / `Writable` streams (defaults: `process.stdin` / `process.stdout`):

- Newline framing on raw bytes, so multibyte characters split across chunks decode correctly. A trailing `\r` is stripped, blank lines are ignored, and invalid UTF-8 is replaced (U+FFFD) rather than rejected.
- Each line is classified by the pure function `classifyInbound`:
  - Malformed JSON gets `-32700` with `id: null`.
  - An invalid envelope or a batch gets `-32600`, echoing the id when it is a valid MCP id.
  - Invalid `tools/call` params get `-32602 "Invalid params"`.
  - Invalid notifications and responses are dropped, because JSON-RPC forbids replying to them.
- Lines over 1 MiB get one `-32600` as soon as the limit is crossed. The rest of the line is discarded, so memory stays bounded and the server keeps running.
- Every outgoing message passes `sanitizeOutbound` (ADR 012), is written as one line, and respects backpressure.
- When stdin ends, the transport closes once every request read before the end has been answered or cancelled (`notifications/cancelled`), counted per id. Replies to piped requests are therefore never lost. A failed stdout write closes the transport, because the client is gone.
- Only the transport writes to stdout. Logs go to stderr via `src/logger.ts`.

## Launching for MCP clients

`npm run task1` prints npm's script banner (`> quilr-assessment@0.1.0 task1`) to **stdout** before the server starts. The server's output is clean, but a client launched this way sees two non-JSON lines. MCP client configs should use `npm run --silent task1` or `node --import tsx task1-mcp-server/index.ts`. Both are covered by spawned-process tests that check every stdout line is JSON-RPC; a plain `npm run task1` launch is also tested with the SDK client, which skips the banner lines.

## Known limitation

In-flight requests are counted per id. A client that reuses an id and then cancels one of the duplicates (or cancels an id that was already answered) can release the wrong entry, so the transport may close after stdin end before the remaining duplicate is answered. JSON-RPC requires unique ids per client, so only a non-compliant client is affected.

## Alternatives considered

- Stock `StdioServerTransport`: no parse or invalid-request replies, and closes on oversize input.
- Subclassing it: its read buffer and line handling are private, so behavior cannot be changed without copying it.

## Consequences

About 200 lines of transport code to own and test. It is covered by unit tests on the pure classifiers, stream-level tests (every split position, size limits, backpressure, lifecycle) and spawned-process tests.
