# 023: Gateway downstream failure handling

- Status: Accepted
- Source: [Spec] (sanitized `-32603` with HTTP 502 for downstream failure) + [Decided] (5xx mapping, idle timeout, size cap, what a client sees once headers are sent)

## Context

ADR 021 handled failures before the downstream's headers arrived. Two cases remained: a downstream that answers 5xx with an error page or a JSON-RPC error, and a downstream that stops sending, or keeps sending without end, after its headers. Both can hold a client connection or leak internals.

## Decision

- **5xx is a gateway failure.** Any downstream status from 500 to 599 is cancelled unread and answered with a sanitized `-32603` "Internal error" and HTTP 502. The id is echoed (`null` for notifications and client responses). Downstream headers and bodies are never relayed. 401 and 403 keep the rule from ADR 021; 2xx and 4xx are relayed unchanged.
- **Declared length over the cap is refused before headers.** A `Content-Length` above the cap gets the same sanitized 502, because the status line has not been sent yet.
- **Idle timeout after headers** (`DOWNSTREAM_IDLE_TIMEOUT_MS`, default 30000, accepted 1000 to 2147483647, digits only). The timer runs only while the gateway waits for the downstream, and is armed again after each chunk. A stall ends the response. The header timeout (`DOWNSTREAM_TIMEOUT_MS`) still governs the wait before headers.
- **Size cap** (`MAX_RELAY_BYTES`, 4 MiB, a constant). Bytes past the cap cut the stream. The cap is not configurable from the environment: one more knob adds configuration surface the assessment does not ask for.
- **Once headers are sent, the status cannot change.** A stall, a cap or a downstream error after headers destroys the connection. The client sees the 200 and a closed stream, never a 502. The failure is logged with its reason (`idle`, `too-large`, `downstream`) and the status already sent.
- **Slow readers are not stalls, up to a point.** The idle timer does not run while the client is slow to read. A client that reads nothing for 30 s (`WRITE_STALL_MS`) is cut, so it cannot pin a downstream connection.
- **Accepted tradeoffs (review):** the total duration is not bounded: a downstream that sends one byte just inside the idle window can hold a stream for a long time while staying under the cap. A 4xx body (for example a downstream HTML 404) is relayed up to the cap, as ADR 021 decided, and not replaced.

## Alternatives considered

- **Deferring the 200 until the first body byte:** would let a stalled stream answer 502, but it delays SSE clients and breaks the early header flush (ADR 021). Rejected.
- **Idle timer that also runs during backpressure:** cuts healthy streams whenever a client reads slowly. Rejected.
- **A per-event size limit:** one stream can still grow without bound. The total is capped instead.
- **Configurable cap:** an extra knob with no requirement behind it. Rejected for now.

## Consequences

- A long SSE stream above 4 MiB is cut. A downstream that trickles bytes slower than the idle window but never stops is still cut by the cap, not the idle window.
- Without a cap, a downstream could hold a socket indefinitely; the cap makes that bounded.
- AC2.5 is backed by `gateway.failures.test.ts` (5xx statuses, leaks, id echo, logs, concurrency, idle and cap behavior) and `gateway-config.test.ts`. Its matrix row has two halves: before headers, a sanitized `-32603` with 502; after headers, the stream ends and the reason is logged.
