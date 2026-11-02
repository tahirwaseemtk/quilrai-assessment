# 005: ESLint `no-console` allowing only `console.error`

- Status: Accepted
- Source: [Spec] (stdout isolation, Task 1) + [Decided] (repo-wide enforcement)

## Context

Task 1 requires that stdout carry only JSON-RPC messages. A single stray `console.log` corrupts the stdio transport. Tasks 2 to 4 serve HTTP and SSE, where stdout logging is not harmful but is still noise.

## Decision

ESLint with `typescript-eslint` (type-checked rules) and Prettier. `no-console` is an error everywhere except `console.error`, which writes to stderr. `@typescript-eslint/no-explicit-any` is an error. `npm run check` runs lint, so CI blocks violations.

## Alternatives considered

- TypeScript strict mode only, plus a grep check: catches less, and grep misses aliased calls.
- Rule scoped to Task 1 only: other tasks gain nothing from stdout logging, so one rule is simpler.

## Consequences

`process.stdout.write` is not caught by this rule. The Task 1 transport is the only place allowed to write to stdout, and the Task 1 end-to-end test verifies that every stdout line is valid JSON-RPC.
