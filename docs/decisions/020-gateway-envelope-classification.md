# 020: Gateway envelope classification and shared JSON-RPC envelope

- Status: Accepted
- Source: [Spec] (-32700 / -32600 / batch handling, Zod envelope) + [Decided] (shared modules, notification and `__proto__` rules, duplicate-key refusal)

## Context

The gateway must answer malformed input itself (AC2.4): the SDK's HTTP transport reports valid JSON that is not JSON-RPC as `-32700`, not `-32600` (ADR 018). Task 1 already has a strict JSON-RPC envelope classifier. The gateway also needs the tool name from `tools/call` to apply the admin gate (2.5), and it must not be fooled by input that parsers read differently.

## Decision

- **Shared JSON-RPC modules** (owner decision), used by Task 1 and Task 2:
  - `shared/jsonrpc-envelope.ts`: the strict MCP envelope schemas and the generic decision tree `readEnvelope`. Ids are strings or safe integers; `params` must be an object; unknown top-level keys are rejected; a response `result` must be an object; a notification is an object with no `id` key and a string `method`. It returns `parse-error`, `invalid-request` (with the id when usable), `request`, `notification`, `response`, `invalid-notification` or `invalid-response`, always with the raw parsed object.
  - Only **one leading byte order mark** is stripped; `JSON.parse` handles JSON whitespace. `trim()` would also accept NBSP, U+2028 and other characters that a downstream JSON parser rejects.
  - `argumentsHaveOwnProto` (the Task 1 rule for an own `__proto__` key in `tools/call` arguments) and `shared/jsonrpc-errors.ts` (standard codes and messages) are shared too.
  - Task 1 maps the outcomes to its replies and keeps its SDK-parity checks. Its suite passes unchanged.
- **Gateway classification** (`task2-mcp-gateway/src/envelope.ts`, `classifyBody`):

  | Input                                                                                                                      | Result                                 |
  | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
  | Malformed JSON (including anything but one BOM before the JSON)                                                            | reply `-32700`, `id: null`             |
  | Non-object, invalid envelope, **any batch array**                                                                          | reply `-32600` (id echoed when usable) |
  | **Any duplicated key** at any depth, compared after decoding escapes and folding (NFKC, then upper- and lower-casing)      | reply `-32600`, `id: null`             |
  | Request that fails the SDK message schema (e.g. non-object `_meta`)                                                        | reply `-32602`, id echoed              |
  | `tools/call` request without own string `name`, with non-object `arguments`, or with an own `__proto__` key in `arguments` | reply `-32602`, id echoed              |
  | Valid `tools/call` request                                                                                                 | `tool-call` with a required `toolName` |
  | Request whose method only folds to `tools/call` (`Tools/Call`, ` tools/call`)                                              | reply `-32600`, id echoed              |
  | Other valid request                                                                                                        | `request`                              |
  | Valid notification other than `tools/call`                                                                                 | `notification`                         |
  | **Any `tools/call` notification** (or a lookalike method), valid or not                                                    | `drop`                                 |
  | Invalid notification or invalid response, or one failing the SDK schema                                                    | `drop` (no reply; HTTP 202 in 2.4)     |
  | Valid client response                                                                                                      | `response`                             |

- The tool name comes from the own `name` property of the raw params, so an inherited `__proto__.name` can never be used.
- **`tools/call` notifications are dropped:** MCP defines none, and without an id there is nowhere to send `-32001`. Forwarding one would be an unanswerable path to a tool.
- Gateway error replies (`src/rpc-errors.ts`) carry fixed messages only, including `-32001 Unauthorized Tool Call`. A code outside the set becomes `-32603 Internal error`.
- **Parser differential: duplicate keys are refused.** `JSON.parse` keeps the last of duplicated keys, other parsers keep the first. A body such as `{"method":"tools/call","method":"tools/list","params":{"name":"admin_x"}}` would look like `tools/list` to the gateway while a first-key downstream runs `admin_x`. A linear scan (`shared/json-duplicate-keys.ts`, keys compared after decoding escapes) refuses any duplicated key at any depth, so every body can be forwarded **byte-for-byte** with no ambiguity and no loss of large-number precision. This replaces the earlier plan to re-serialize `tools/call` bodies, which the code review showed would not cover a duplicated `method` key.
  - Keys are compared after folding because some parsers match keys loosely: Go's `encoding/json` matches struct fields case-insensitively, with the last match winning, and folds U+017F to `s` and U+212A to `k`; normalizing parsers equate fullwidth letters. Without folding, `{"name":"echo","NAME":"admin_delete"}` would be gated as `echo` while a Go downstream ran `admin_delete` (found by the security review).
  - A method that folds to `tools/call` without being spelled exactly that way is refused, so a downstream that trims or lowercases methods cannot run an ungated tool call.
  - **Precondition for the HTTP layer (2.4):** the body is decoded as strict UTF-8 (invalid or overlong sequences are a parse error), only a missing charset or `charset=utf-8` is accepted, and the gateway sends its own `Content-Type: application/json` downstream. The text classified here is then exactly the text the downstream reads.
  - The refusal also applies to bodies shaped like notifications or responses: they get a `-32600` reply with `id: null` rather than being dropped, because which keys they carry is ambiguous. The HTTP layer (2.4) answers these with HTTP 400, not 202.
  - The single leading byte order mark that is accepted is stripped before forwarding (2.4), so the downstream parses exactly the text that was classified.
- `tools/call` is classified as its own kind with a required `toolName`, so the 2.5 gate cannot be skipped by a branch that forgets to look for it.
- The tool-name pattern and the admin gate are applied in 2.5. Body limits, content type and HTTP status codes are applied in 2.4.

## Alternatives considered

- A separate copy of the envelope schemas in Task 2: no Task 1 change, but two definitions of a valid message would drift.
- Relying on the downstream for malformed input: wrong codes (`-32700` for invalid envelopes) and the body would reach the downstream.
- Forwarding `tools/call` notifications: they would bypass the admin gate's error reply.
- Re-serializing forwarded bodies: removes ambiguity, but changes large numbers and only helps for the methods it is applied to.

## Consequences

Malformed input never reaches the downstream. Task 1 and Task 2 share one definition of a valid envelope; a change to it is tested by both suites.
