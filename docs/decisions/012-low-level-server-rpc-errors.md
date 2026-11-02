# 012: Low-level SDK `Server` with fixed-message `RpcError`

- Status: Accepted
- Source: [Spec] (JSON-RPC error codes, no internals in errors) + [Decided] (mechanism)

## Context

The assessment requires invalid tool input to be rejected with standard JSON-RPC error codes. With `@modelcontextprotocol/sdk` 1.32.2:

- `McpServer.registerTool` reports argument validation failures as a `CallToolResult` with `isError: true`, not as a JSON-RPC error.
- `McpError` prefixes every message with `"MCP error <code>: "`.
- The SDK's own `tools/call` request validation returns the Zod issue dump as the error message. A spike showed `tools/call` without `params.name` answered with `-32603` and the full issue list.

The SDK protocol layer copies any thrown error with a numeric `code` to the wire, using `error.message` verbatim.

## Decision

- Use the low-level `Server` with `setRequestHandler` for `tools/list` and `tools/call`. Tools are registered through a `ToolDefinition` registry passed to `createServer`.
- Handlers throw `RpcError` (numeric `code`, exact message, no prefix). Unknown tools get `-32602 "Unknown tool"`.
- A plain `Error` from a tool handler is logged to stderr with its detail and answered with `-32603 "Internal error"`.
- Params are checked before the SDK sees them (`src/inbound.ts`): every message against the SDK's `JSONRPCMessageSchema`, and `initialize`, `ping`, `tools/list` and `tools/call` against the SDK request schemas (plus `arguments` must be an object and `task` is refused, since task support is not declared). A failure is answered `-32602 "Invalid params"`. Without this, the SDK silently drops messages that fail its schema (leaving the request unanswered), answers `-32603` for bad params on built-in methods, or leaks Zod text for `tools/call`.
- Every outgoing error passes a per-code allowlist (`src/outbound.ts`). Unknown codes become `-32603`, messages outside the allowlist become the canonical message for their code, and `data` is dropped.

## Alternatives considered

- `McpServer` with Zod `inputSchema`: idiomatic, but produces `isError` results for invalid input, contrary to the requirement.
- Throwing `McpError`: correct codes, but prefixed messages.
- Catching and rewriting errors only in handlers: misses errors produced inside the SDK before handlers run.

## Consequences

Error messages on the wire are a closed set. New field-level messages (sub-task 1.4) are composed from the fixed fragments in `src/field-errors.ts` and checked by its composition rule (ADR 016), or they are replaced with the canonical message.
