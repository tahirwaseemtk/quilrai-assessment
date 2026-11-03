# 021: Gateway HTTP layer and passthrough proxy

- Status: Accepted
- Source: [Spec] (401 + `WWW-Authenticate`, 413 / 415, `tools/list` passthrough with streaming, no client `Authorization` downstream, sanitized `-32603` / 502) + [Decided] (check order, status mapping, header allowlists, header-only timeout, lingering close, config rules)

## Context

Sub-task 2.4 puts the pieces from 2.1–2.3 (token table, `authenticate`, `classifyBody`) behind a real HTTP server, `npm run task2`. The gateway must refuse bad input before reading or forwarding anything it does not need, forward everything else unchanged, stream the downstream's JSON or SSE response back, and never leak the client's credential downstream or the downstream's internals to the client.

## Decision

- **Request pipeline** (`src/gateway.ts`). Each check answers or passes on, in a fixed order pinned by tests:

  | Step | Check                                                                                                     | Answer                                                                                 |
  | ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | 1    | Raw request-target before `?` equals `/mcp` (no `new URL()`, which throws on targets like `http://[/mcp`) | 404 `Not Found`                                                                        |
  | 2    | Method is `POST`                                                                                          | 405 `Method Not Allowed`, `Allow: POST`                                                |
  | 3    | `authenticate(req.headersDistinct.authorization)`                                                         | 401 `Unauthorized`, `WWW-Authenticate: Bearer`, same for every reason                  |
  | 4    | Exactly one `Content-Type`: `application/json`, no parameter or only `charset=utf-8` (quoted allowed)     | 415 `Unsupported Media Type`                                                           |
  | 5    | `Content-Length` at most 1 MiB (1,048,576 bytes; a BOM counts)                                            | 413 `Payload Too Large`, before reading the body                                       |
  | 6    | At most one `Mcp-Session-Id` and one `MCP-Protocol-Version` header                                        | 400 `Bad Request`                                                                      |
  | 7    | Body read with a running limit (chunked bodies stop at limit + 1 and are never buffered past it)          | 413                                                                                    |
  | 8    | Strict UTF-8 (`TextDecoder` with `fatal: true` and `ignoreBOM: true`)                                     | 400, `-32700`, `id: null`                                                              |
  | 9    | `classifyBody` (ADR 020)                                                                                  | `-32700` / `-32600` with HTTP 400; `-32602` with HTTP 200; `drop` with 202 and no body |

  `ignoreBOM: true` keeps the decoder from stripping a BOM, so `classifyBody` strips exactly one; the default would strip a second and let a double-BOM body through. The forwarded bytes drop the same single BOM (`withoutByteOrderMark`), so the checked text and the forwarded bytes match.

- **Lingering close** (`src/responses.ts`). Node closes the connection as soon as a response ends while the request body is still arriving, which can reset the connection before the client reads the answer (seen on Windows). For an answer sent before the body is complete, the gateway writes the whole answer, discards (never buffers) the rest of the body for at most 1 s, then ends the response and destroys the socket if the body is still incomplete. Node adds `Connection: close` itself. A chunked body that never ends is cut at about 1 s.
- **Forwarding** (`src/forward.ts`):
  - `fetch` POST to the configured URL. The client's query string is never appended. Redirects are refused (`redirect: 'error'`), so the gateway credential is never resent elsewhere.
  - Request headers are an allowlist: `content-type: application/json` (the gateway's own), `authorization: Bearer <DOWNSTREAM_AUTH_TOKEN>`, and the client's `accept`, `mcp-session-id`, `mcp-protocol-version`. The client's `Authorization`, cookies and proxy headers never reach the downstream.
  - Response: status, `content-type` and `mcp-session-id` only. `Set-Cookie`, `WWW-Authenticate` and server headers are dropped. Headers are flushed at once, and the body streams through `pipeline` without buffering (JSON or SSE).
  - A downstream 401 or 403 becomes 502 `-32603`: relaying it would tell the client its own token was wrong. Other statuses are relayed in 2.4; 5xx handling follows in 2.6.
  - The timeout (`DOWNSTREAM_TIMEOUT_MS`) covers only the wait for response headers, so a long SSE stream is not cut.
  - A network error, refused redirect or timeout before headers gives 502 with `rpcError(id, -32603)` (id `null` for notifications and client responses). Only a short error code (`ECONNREFUSED`, `TIMEOUT`) is logged, never the URL.
  - A client disconnect aborts the downstream call, before or after headers.
- **Config** (`src/gateway-config.ts`): `GATEWAY_PORT` (default 8080) and `DOWNSTREAM_TIMEOUT_MS` (default 5000, at most 2^31 − 1 because Node turns larger timer delays into 1 ms) accept digits only; a blank value means the default. `DOWNSTREAM_MCP_URL` must be http(s) with no userinfo and is stored normalized. `DOWNSTREAM_AUTH_TOKEN` must be `token68`. Failures list setting names only. After parsing, `consumeSecrets` deletes `GATEWAY_TOKENS` and `DOWNSTREAM_AUTH_TOKEN` from `process.env`.
- **Logging:** one `request` line per request with `http_method`, `rpc_method` (when known), `status` (499 when the client left first) and `duration_ms`. No headers, bodies, tokens or URLs. Startup logs the placeholder-token warning, `listening`, or a sanitized `invalid configuration` / `listen failed` before exit 1.
- The gateway binds `127.0.0.1`.

## Alternatives considered

- **`Connection: close` and closing at once** (the original 2.4 design): resets the connection on Windows before the client reads the 413. Replaced by the lingering close.
- **Denylisting hop-by-hop and auth headers:** a new or unusual header would leak by default. Allowlists fail closed.
- **A total request timeout:** would cut legitimate long SSE streams. A stalled downstream after headers is tracked for 2.6.
- **Proxying GET (SSE notification stream) and DELETE (session end):** the assessment needs POST only, and the mock downstream is stateless. 405 is allowed by the Streamable HTTP spec for GET; DELETE support can be added with the same allowlists.
- **Relaying a downstream 401:** misleads the client about its own credential.

## Consequences

- AC2.1 (HTTP 401), AC2.2 (byte-identical forwarding and streaming) are backed by HTTP tests; AC2.5 has its basic 502 cases.
- Admin gating (2.5) plugs in on the `tool-call` kind before `forwardRequest`. Until then, `tools/call` is forwarded for every authenticated role.
- Downstream 5xx, a stalled stream after headers and response size limits are handled in 2.6.
