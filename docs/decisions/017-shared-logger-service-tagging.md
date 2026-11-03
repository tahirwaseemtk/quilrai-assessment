# 017: Shared stderr logger with per-service tagging

- Status: Accepted
- Source: [Decided]

## Context

Task 1 introduced a stderr JSON logger. Task 2 needs the same logger for the gateway and for its mock downstream server, and CLAUDE.md puts code used by two or more tasks in `shared/`. Several processes (a task, its stub provider, a test runner) can write to the same terminal, so a reviewer must be able to tell which process wrote each line.

## Decision

- The logger moves from `task1-mcp-server/src/logger.ts` to `shared/logger.ts`, with its tests in `shared/test/logger.test.ts`. Its behavior is unchanged: JSON lines on stderr, level filtering via `LOG_LEVEL`, safe serialization of errors, BigInt and circular objects.
- `createLogger` requires a non-empty `service` name, and every line carries it:

  | Process                | `service`           |
  | ---------------------- | ------------------- |
  | Task 1 server          | `task1-mcp-server`  |
  | Task 2 gateway         | `task2-mcp-gateway` |
  | Task 2 mock downstream | `mock-downstream`   |

- `service`, `time`, `level` and `msg` are written last, so caller fields cannot overwrite them.
- **Redaction:** keys are compared lowercased without `-` or `_`.
  - Always redacted (`[REDACTED]`) when the key is `cookie`, `set-cookie`, `jwt`, `bearer`, `pwd` or `authheader`; contains `authorization`, `secret`, `password`, `passwd`, `credential`, `privatekey`, `accesskey` or `session`; or ends with `token`, `apikey` or `apikeys`.
  - A key ending in `tokens` is a usage count when its value is a number and is kept (`max_tokens`, `cache_read_input_tokens`, ...). Any other value is redacted, which catches credential tables such as `GATEWAY_TOKENS` without hiding Task 4's counts.
  - It applies at any depth, inside arrays and inside error causes. In name/value lists such as Node's `req.rawHeaders`, the value after a secret name is redacted.
  - Credentials in URLs (`scheme://user:pass@host`) are masked in every string value.
  - Known limitations: the message text and error messages are not scanned, so call sites must never interpolate credentials; lookalike Unicode keys are not normalized.
- **Never throws:** if fields cannot be serialized (a recursive `toJSON`, a throwing getter), the logger writes a fixed line with `log_error: "unserializable fields"` and no field content. Logging sits on error paths, where a throw would replace a sanitized response.
- Each task creates its own logger instance. There is no global logger, so one task's level or sink never affects another.

## Alternatives considered

- A copy of the logger per task: duplicated code and tests that would drift apart.
- An optional `service` field: easy to forget, which would bring back unattributed lines.

## Consequences

Task 1's call sites pass `service: 'task1-mcp-server'`, and its real-process tests assert that every log line carries it. Adding a task means picking a service name, nothing more.
