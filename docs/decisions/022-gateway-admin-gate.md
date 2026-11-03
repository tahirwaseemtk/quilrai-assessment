# 022: Gateway admin gate and tool-name check

- Status: Accepted
- Source: [Spec] (`admin` / `admin_*` require role `admin`, `-32001` "Unauthorized Tool Call", tool-name pattern with `-32602`, authorization as a pure function) + [Decided] (case-insensitive match, punctuation, check order, HTTP status, fail-closed role)

## Context

Sub-task 2.5 adds the rule that makes the gateway a security gateway: a viewer must never get an admin tool executed downstream. The gate runs on the `tool-call` kind from `classifyBody` (ADR 020), after authentication (ADR 019) and before forwarding (ADR 021). A downstream may normalize tool names differently from the gateway (case, Unicode, whitespace), so anything the gateway cannot judge reliably must be refused rather than guessed at.

## Decision

- **`isValidToolName`** (`src/tool-name.ts`): `^[A-Za-z0-9_.-]{1,128}$`, ASCII only, run on the parsed string. A failing name gets `-32602` "Invalid params", for **both roles**, before the gate is consulted. Names are never trimmed or decoded: `"admin "`, `"%61dmin"`, fullwidth or Cyrillic lookalikes and zero-width characters are invalid, not rewritten into `admin`. No `u` or `i` flag is used on this pattern.
- **`authorize(role, toolName)`** (`src/authorize.ts`): pure, returns `'allow' | 'deny'`. The admin role is always allowed. Any other role is denied a name matching `/^admin(_|$)/i`, so an unknown role fails closed. The name is only tested with the regex, never used as an object key, so `constructor` and `__proto__` are ordinary names.
  - **Case-insensitive** (owner decision): `Admin`, `ADMIN_x` are gated. A downstream that matches names without regard to case would otherwise run an admin tool for a viewer. The cost is that a public tool whose name only differs in case from `admin_*` is denied to viewers. The `i` flag is used without `u`, so U+212A (Kelvin) and U+017F (long s) do not fold to ASCII letters; they are rejected earlier by the name check anyway.
  - **Only `_` extends the prefix** (owner decision, as the spec reads): `admin.x`, `admin-x` and `administrator` are not gated. A downstream with `admin.`/`admin-` naming conventions must be protected by a different rule; the gate can be widened to `^admin([_.-]|$)` in one line.
  - `admin_` (empty suffix) is gated, since `admin_*` includes it.
- **Gate placement** (`src/gateway.ts`, `refuseToolCall`): after `classifyBody`, on `kind === 'tool-call'` only. Order: auth (401) → content type (415) → size (413) → repeated headers (400) → body decoding and classification (ADR 021) → tool-name check → gate → forward. Other methods, notifications and client responses are never gated; every `tools/call` notification is dropped (ADR 020).
- **Answers:** `-32001` "Unauthorized Tool Call" and the name-check `-32602` are JSON-RPC errors with the request id echoed, only `code` and `message`, and HTTP 200 (through `replyStatus`, like the classifier's `-32602`). Nothing is forwarded, so the downstream's call record stays empty. The log line stays `request` with `rpc_method: tools/call` and `status`; it carries no tool name, role, or "denied" flag.

## Alternatives considered

- **Literal, case-sensitive match:** follows the spec text most closely, but fails open against a case-insensitive downstream.
- **Gating every `admin` followed by a non-alphanumeric character:** safer for `admin.x`/`admin-x`, but stricter than the spec and not asked for. Left as a one-line change.
- **Allowlist of viewer tools:** the strongest design, but the gateway does not know the downstream's tool inventory and the spec defines the rule by name prefix.
- **Trimming or Unicode-normalizing names before the gate:** hides the same ambiguity the strict regex removes; a name the gateway rewrites is a name the downstream and gateway may read differently.
- **`-32001` for invalid names too (or 403):** `-32602` is what the spec asks for, and an unreadable name is a malformed request, not a permission question.

## Consequences

- AC2.3 and the name part of AC2.4 are backed by `authorize.test.ts`, `tool-name.test.ts` and `gateway.admin-gate*.test.ts`, including an end-to-end run with the real mock.
- Because a viewer calling an invalid gated-looking name (`"admin reset"`) gets `-32602` while `"admin_reset"` gets `-32001`, a client can tell the two apart. The names themselves are not secret (they come from the client), so this is accepted.
- The classifier is the only thing that routes `tools/call` to the `tool-call` kind; its lookalike and notification rules (ADR 020) are therefore part of the gate's guarantee, and `envelope.test.ts` keeps them pinned.
