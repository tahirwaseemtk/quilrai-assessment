# 018: Mock downstream MCP server

- Status: Accepted
- Source: [Spec] (a downstream mock MCP server) + [Decided] (transport, credential, spy)

## Context

The gateway sits between an agent client and a downstream MCP server. Its tests must prove that requests are forwarded unchanged, that blocked calls never reach the downstream, and that the client's own token is never forwarded. That needs a downstream that is a real MCP server and that records what it actually executed.

## Decision

- **A real MCP server.** `task2-mcp-gateway/mock-downstream/` serves an SDK `Server` over `StreamableHTTPServerTransport` at `POST /mcp`, bound to `127.0.0.1`.
  - It runs stateless: a new transport per request, as the SDK requires, and no session id. Clients can call `tools/list` and `tools/call` without an `initialize` handshake.
  - Responses are plain JSON by default. A `jsonResponse: false` option answers with an SSE stream, so the gateway's streaming passthrough can be tested.
- **Tools:**
  - `get_status` is a normal tool.
  - `admin_reset_key` (requires a `key_id` string) and `admin` are the admin-only tools the gateway must gate.
  - Arguments are strict: bad arguments give `-32602 "Invalid params"`, and an unknown tool gives `-32602 "Unknown tool"`, matching Task 1.
- **Downstream credential:** the mock accepts only `Authorization: Bearer <DOWNSTREAM_AUTH_TOKEN>`. That is the gateway's own credential, never a client token. Anything else gets `401 Unauthorized` with `WWW-Authenticate: Bearer`, checked before the body is read.
  - Checks run in this order: path (404), method (405 for anything but POST), credential (401), then MCP.
  - The bearer scheme is case-insensitive (RFC 7235); the token is compared in constant time (`src/bearer.ts`, shared with the gateway).
- **Call spy:** `calls` lists the tools that actually ran, in order. A call is recorded after the tool succeeds, as a snapshot. `initialize`, `tools/list` and failed calls are not recorded.
- **Entry point:** `npm run task2:mock`. `MOCK_DOWNSTREAM_PORT` defaults to 8081 and `DOWNSTREAM_AUTH_TOKEN` is required. A missing token exits with code 1 and logs only the names of the invalid settings.

## SDK transport behavior the gateway must not rely on

The tests pin these, because the gateway answers them itself (AC2.4):

| Input                                       | SDK HTTP transport answer        |
| ------------------------------------------- | -------------------------------- |
| `Accept` without both JSON and event-stream | 406, `-32000`                    |
| Non-JSON `Content-Type`                     | 415, `-32000`                    |
| Malformed JSON                              | 400, `-32700`                    |
| Valid JSON that is not JSON-RPC             | 400, **`-32700`** (not `-32600`) |
| Batch of more than 100 messages             | 400, `-32600`                    |
| Unsupported `mcp-protocol-version` header   | 400, `-32000`                    |

## Alternatives considered

- A hand-rolled JSON-RPC responder: simpler, but it would not prove the gateway works with a real MCP server.
- A stateful mock with sessions: realistic, but every test would need an `initialize` handshake. The gateway forwards `Mcp-Session-Id` regardless.
- Spying on HTTP requests instead of tool executions: a request can reach the mock without running a tool, so it would not prove "no downstream execution".

## Consequences

Gateway tests start a fresh mock per test on a random port and assert on `calls`. The mock's 401 rule makes forwarding the client's token fail visibly.
