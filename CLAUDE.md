# CLAUDE.md

Project: QuilrAI AI Field Developer / Solutions Engineer assessment.
A single public repo containing four independent tasks, all in TypeScript on Node 22.12+.

## Goal

Deliver four working, tested solutions that a reviewer can run with one npm command each. Code quality, protocol correctness, and clear tradeoffs matter more than feature volume.

## Tech stack

- Runtime: Node 22.12+, TypeScript 6.0 (strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). TypeScript stays on 6.0 until `typescript-eslint` supports 7 (ADR 008).
- Runner: tsx for scripts, vitest for tests
- Lint/format: ESLint (typescript-eslint) and Prettier
- Validation: Zod at every external input boundary
- MCP: official `@modelcontextprotocol/sdk`
- HTTP: Node built-in `http`
- Database: `better-sqlite3`, on-disk file, path from `SQLITE_PATH` (default `data/rate-limit.db`)
- Env: loaded with Node's `--env-file-if-exists=.env`; no dotenv
- Do not add dependencies without asking me first.

## Layout

```
taskN-<name>/
  index.ts       # entry point
  src/           # implementation
  test/          # vitest tests for this task
shared/          # only when two or more tasks need it
docs/
  decisions/     # ADRs: NNN-short-title.md
  taskN-<name>/  # task README: design, tradeoffs, AC matrix, sub-task log
.claude/agents/  # project review subagents
```

Task folders: `task1-mcp-server`, `task2-mcp-gateway`, `task3-stream-guardrail`, `task4-rate-limit-router`.

## Commands

- `npm run task1` / `task2` / `task3` / `task4`: start each task
- `npm run task2:mock`, `task3:provider`, `task4:providers`: start local stubs for manual demos
- `npm test`, `npm run test:taskN`: run vitest
- `npm run typecheck`, `npm run lint`, `npm run format`
- `npm run check`: typecheck + lint + format check + test. Run it before saying anything is done.
- Task and stub scripts are added in the sub-task that creates their entry file.

## Task rules

### Task 1: MCP server

- stdout is reserved for JSON-RPC only. Never use `console.log`, `console.info`, or `process.stdout.write` for logs. Use the stderr logger.
- Connect over stdio. If the SDK `StdioServerTransport` does not answer malformed JSON with `-32700`, use a small transport implementing the SDK `Transport` interface that does.
- Use the low-level SDK `Server`. Every tool declares a Zod `args` schema, and the server validates it in the shared `tools/call` path (`runTool`) before the handler runs, so invalid input returns JSON-RPC `-32602` instead of an `isError` tool result.
- Tools:
  - `get_customer_record`: `customer_id` must match `^CUST-\d{5}$`
  - `trigger_refund`: `customer_id` (same format), `amount` positive finite number with at most 2 decimals, `reason` trimmed string with at least 10 characters
- Strict objects: unknown keys are rejected.
- Error codes: `-32700` parse error (`id: null`), `-32601` unknown method, `-32602` invalid params or unknown tool. Messages are fixed strings; no Zod internals or stack traces.
- Business failures (customer not found, refund exceeds balance) return a tool result with `isError: true`.
- Test by spawning the server and checking that every stdout line parses as JSON-RPC.

### Task 2: MCP security gateway

- Read `Authorization: Bearer <token>`. Map tokens to roles through config (`GATEWAY_TOKENS`), compared in constant time. Roles: `admin`, `viewer`.
- Missing, malformed, or unknown token: HTTP 401 with `WWW-Authenticate: Bearer`.
- `tools/list` and other non-`tools/call` methods: forward to the downstream server unchanged, streaming the response back.
- `tools/call`: tool names `admin` and `admin_*` require role `admin`. Otherwise return JSON-RPC error `-32001` ("Unauthorized Tool Call") without contacting the downstream server.
- Reject tool names not matching `^[A-Za-z0-9_.-]{1,128}$` with `-32602`.
- Parse the JSON-RPC envelope with Zod. Malformed JSON: `-32700`. Invalid envelope or batch array: `-32600`.
- Never forward the client's `Authorization` header downstream; use the gateway's own downstream credential.
- Enforce a 1 MB body limit (413) and `application/json` content type (415).
- Downstream failure: sanitized `-32603`, HTTP 502.
- Authorization is a pure function, tested separately from the HTTP layer.
- Include a small mock downstream MCP server for testing.

### Task 3: Streaming PII redaction

- Process the stream chunk by chunk with async iterators. Do not accumulate the full response.
- Use a prefix-aware holdback: hold back only trailing text that could still become a match, capped at a maximum derived from the pattern definitions.
- Redact emails, SSNs (`###-##-####`), and Luhn-valid 13-19 digit card numbers as `[REDACTED]`.
- Decode bytes with `TextDecoder({ stream: true })` so multibyte characters survive chunk splits.
- Respect backpressure and abort upstream on client disconnect.
- Regexes use bounded quantifiers only (ReDoS-safe).
- Tests must split sample text at every possible byte position and confirm no PII appears in the output.
- Document the tradeoff between holdback size, detection coverage, and latency in the task doc.

### Task 4: Rate limiter and model fallback

- Token-aware sliding window per tenant API key, default 50,000 tokens per 60 seconds, configurable.
- Store usage in SQLite (WAL mode) with timestamped rows. Store tenant keys as SHA-256 hashes, never raw. Evict rows older than the window on each check.
- Check-and-reserve runs in an immediate transaction. Reconcile with reported usage after the call; release the reservation if both providers fail.
- Fail over to the secondary provider on 429, a 3000 ms timeout (`AbortController`), network error, or 5xx. Other 4xx errors do not fail over.
- Errors return `{"error": {"code": "...", "message": "...", "request_id": "..."}}`. Never include upstream bodies, stack traces, URLs, or internal paths. Full detail goes to the stderr log only.
- Inject a clock, provider clients, and the database so tests can use a fake clock and stubbed providers.

## Code style

- Strict TypeScript. No `any`. Use `unknown` and narrow with Zod.
- Named exports. One responsibility per file.
- Small pure functions for logic that tests need to hit directly (for example, the redaction matcher, the authorization check, and the sliding window math).
- Comments explain why, not what. Only where the reasoning is not obvious.
- ESLint `no-console` allows only `console.error`.

## Security and hygiene

- Never commit secrets. Provider keys and URLs come from `.env`; commit only `.env.example`.
- Never commit `node_modules/`, `.env`, `data/`, `*.db`, or `dist/`.
- No debug output left in committed code.

## Git workflow

- Branches: `taskN/main` per task, `taskN/N.M-short-slug` per sub-task (created from `taskN/main`). Chores: `chore/<slug>`, docs: `docs/<slug>`.
- Claude creates sub-task branches and commits only after I approve the diff. Claude never pushes, opens PRs, or merges.
- Commit messages: `task1.2: validate customer_id format`.
- Sub-task branches merge into `taskN/main` through a PR with `--no-ff`. Only finished, reviewed tasks merge into `main`.
- When a branch is ready to push, Claude writes the PR description using every section of `.github/pull_request_template.md`, filled from the actual diff, test output, ADRs, and AC matrix.

## Sub-task loop

1. `test-designer` drafts the edge-case list; I approve it.
2. Write failing tests, then the implementation.
3. `npm run check` passes.
4. Review: `/code-review` on the diff, then the specialist reviewer (`mcp-protocol-reviewer` or `security-reviewer`), then `spec-reviewer`.
5. Update the task doc (sub-task log, AC matrix) and add an ADR for any decision.
6. Show the diff and proposed commit message; commit after approval.
7. Write the filled-in PR description for the branch.

## Documentation

- Each decision gets an ADR in `docs/decisions/`: status, context, decision, alternatives, source (`[Spec]` or `[Decided]`).
- Each task doc has an acceptance criteria matrix. A criterion is ticked only when a named test or verifiable check backs it.
- A behavior change without the matching doc or ADR update is incomplete.
- Keep the root README short and in sync with how to run each task.

## Working rules for Claude

- Before editing, state what you will change and why. Wait for my go-ahead on anything non-trivial.
- Work on one sub-task at a time. Don't touch another task's folder unless shared code requires it.
- After each change, run the relevant test or typecheck and report the result.
- If a requirement is ambiguous, ask one concise question instead of guessing.

## Done means

- The task runs with its npm command.
- Tests cover the scoring criteria listed in the assessment for that task.
- `npm run check` passes.
- The task doc explains setup, design decisions, and tradeoffs, and every acceptance criterion is ticked with evidence.
