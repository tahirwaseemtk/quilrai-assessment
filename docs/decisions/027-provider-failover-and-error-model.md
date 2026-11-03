# 027: Provider failover policy and sanitized error model

- Status: Accepted
- Source: [Spec] (failover on 429, 3000 ms timeout, network error or 5xx; other 4xx do not fail over; error body `{"error":{"code","message","request_id"}}`; no upstream bodies, stack traces, URLs or paths in errors; full detail to the log) + [Decided] (timeout covers the whole call, redirects refused, fixed messages, status mapping)

## Context

A failover router is only safe if it fails over for the right reasons. Retrying a request that the provider rejected spends a second provider's quota for nothing. And an error body that echoes an upstream failure can leak the provider's URL, its internal paths or its key.

## Decision

- **Failover triggers.** Primary outcomes that try the secondary: HTTP 429, any 5xx, a timeout, a network error, or a 2xx whose body is not JSON. Any other 4xx is a rejection: the request is at fault, another provider would refuse it too, so no failover and the reservation is released.
- **Timeout.** `AbortController` with a timer, per provider, covering the whole call including the body. A late answer after the timeout is discarded: the abort rejects the fetch, so each call settles once.
- **Redirects** are refused (`redirect: 'error'`), so the provider key is never resent to another host.
- **Outcome of the chain.** Served by either provider: 200 with the provider's body and the reservation settled. Primary rejected: `UPSTREAM_REJECTED` (502). Both retryable: `UPSTREAM_UNAVAILABLE` (502). Rate limit: 429 before any provider is called. A cost above the whole limit is refused with 400 `INVALID_REQUEST` before any reservation, because no wait could admit it.
- **Error body.** Always `{"error":{"code","message","request_id"}}`, with the messages fixed per code. `request_id` is a random UUID, also sent as `x-request-id`. The 429 response adds `Retry-After`.
- **Oversized requests.** A request whose estimate exceeds the whole tenant limit can never be admitted, so it gets `INVALID_REQUEST` (400) at once rather than a 429 with a wait that cannot succeed. No provider is called.
- **Logs.** Failure detail goes to stderr with the request id: the provider name, the status number, the reason (`timeout`, `network`, `status 429`), and a short network code such as `ECONNREFUSED`. Never the URL, the key, the prompt, or the upstream body.
- **Status codes.** `INVALID_REQUEST` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `UPSTREAM_UNAVAILABLE` and `UPSTREAM_REJECTED` 502, `INTERNAL` 500.

## Alternatives considered

- **Failing over on every error:** would spend the secondary's quota on requests the first provider already refused. Rejected.
- **Returning the upstream error body:** useful for debugging, but it can carry internal detail. Rejected; the log carries it instead.
- **Retrying the same provider:** adds latency for no gain against a 429 or outage. Rejected.
- **A total deadline across both providers:** the plan allows each provider its own timeout; the total is bounded at twice the timeout, which is documented.

## Consequences

- The response time of a failed chain is at most two timeouts (6 s with the defaults) plus the local work.
- A malformed 2xx counts as retryable and therefore fails over, which is the conservative reading.
- Error bodies are the same for every cause within a code, so they reveal nothing about which provider failed.
