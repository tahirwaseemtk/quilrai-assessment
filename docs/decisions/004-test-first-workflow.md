# 004: Test-first sub-task loop with staged reviews

- Status: Accepted
- Source: [Decided]

## Context

The assessment scores protocol correctness, validation edge cases, and security behavior. These need explicit tests, not incidental coverage.

## Decision

Each sub-task follows the same loop:

1. The `test-designer` agent drafts the edge-case list; the owner approves it.
2. Failing tests are written, then the implementation.
3. `npm run check` passes (typecheck, lint, format check, tests).
4. Reviews run in order: `/code-review` on the diff, the specialist reviewer (`mcp-protocol-reviewer` or `security-reviewer`), then `spec-reviewer` against the acceptance criteria.
5. The task doc's sub-task log and acceptance criteria matrix are updated, plus an ADR for any decision.

An acceptance criterion is ticked only when a named test or verifiable check backs it.

## Alternatives considered

- Tests after implementation: tends to test what was built rather than what was required.
- A single review at the end of each task: problems surface late, when they are expensive to fix.

## Consequences

Slower per sub-task, but every scoring criterion maps to evidence a reviewer can run.
