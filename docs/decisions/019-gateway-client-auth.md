# 019: Gateway client authentication and role config

- Status: Accepted
- Source: [Spec] (Bearer token to role) + [Decided] (config format, comparison, header rules, warnings)

## Context

The gateway reads `Authorization: Bearer <token>` and derives a role (`admin` or `viewer`) that decides which tools a client may call. The 2.1 security review carried four items forward: compare every configured token in constant time, refuse duplicate `Authorization` headers, keep credentials out of logs, and decide what to do with the placeholder tokens in `.env.example`.

## Decision

- **Config:** `GATEWAY_TOKENS` is a JSON object `{ "<token>": "admin" | "viewer" }`, parsed by `parseTokenConfig` (`src/token-config.ts`). The object shape and the role are checked with Zod; entries are then read from the parsed object itself, because Zod's copy would drop an own `__proto__` key.
  - Every token must use RFC 6750 `token68` characters, and every role must be exactly `admin` or `viewer`. One bad entry rejects the whole config.
  - Missing, blank, non-JSON, non-object and empty values are rejected with fixed reasons that never contain a token.
  - Keys are read with `Object.entries`, so `__proto__` or `constructor` are ordinary tokens and nothing is looked up on an object prototype. A duplicated token is **rejected**: `JSON.parse` would keep the last value and silently change that token's role.
- **Digests only:** the parsed table is a frozen list of `{ digest, role }`, where the digest is SHA-256, and holds no raw token. The raw value remains in `process.env.GATEWAY_TOKENS` until the gateway entry point clears it after a successful parse (sub-task 2.4).
- **Authentication:** `authenticate(authorization, table)` (`src/auth.ts`) is a pure function, tested apart from HTTP. It returns a role, or one of `missing`, `malformed`, `duplicate` or `unknown`.
  - It takes only the shape of Node's `req.headersDistinct.authorization` (`readonly string[] | undefined`), never the de-duplicated `req.headers.authorization`, so the type keeps a caller from bypassing the duplicate check. **More than one `Authorization` header is refused** before anything else, so a proxy that keeps the last value and Node, which keeps the first, cannot disagree about the token.
  - The presented token is hashed once and **compared against every entry with `timingSafeEqual` (exported as `constantTimeEqual`, and the test asserts the identity), with no early exit**. The response time therefore does not reveal whether or where the token is configured.
- **Placeholders:** tokens shorter than 16 characters, or containing `replace-with`, `replace-me`, `changeme`, `change-me`, `example` or `placeholder` (in any case), are accepted. `parseTokenConfig` returns a warning that names only the setting, and the gateway entry point logs it at startup (sub-task 2.4). This keeps `cp .env.example .env` working for a reviewer while still flagging the risk (owner decision).
- **Logs:** the shared logger redacts credential-named fields (ADR 017).
- **HTTP 401** with `WWW-Authenticate: Bearer` is rendered by the gateway's HTTP layer (sub-task 2.4).

## Alternatives considered

- A `Map` keyed by the raw token: a fast lookup, but its timing depends on the token and it keeps raw tokens in memory.
- Stopping at the first match: shorter, but it reveals the position of a matching token.
- Using the first or last `Authorization` header: Node and a proxy could pick different ones.
- Refusing placeholder tokens at startup: safest, but the reviewer would have to edit `.env` before the first run.

## Consequences

Authentication costs one SHA-256 per request plus one comparison per configured token. That is negligible for the handful of tokens a gateway like this holds.
