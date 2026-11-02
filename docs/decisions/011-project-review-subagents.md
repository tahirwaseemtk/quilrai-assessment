# 011: Project review subagents

- Status: Accepted
- Source: [Decided]

## Context

Each sub-task passes several reviews before it is committed (ADR 004). The reviews need consistent checklists tied to the assessment's scoring criteria, and they must not modify the code they review.

## Decision

Four project subagents live in `.claude/agents/`. All are read-only: tools are limited to `Read, Grep, Glob, Bash`, and each prompt forbids editing files and state-changing git commands. Each returns a fixed output format with a verdict and `file:line` findings.

| Agent                   | Role                                                                                          | Verdict rule                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `test-designer`         | Drafts the edge-case test table for a sub-task, mapped to acceptance criteria; writes no code | Lists coverage gaps and open questions          |
| `mcp-protocol-reviewer` | Stdout hygiene, JSON-RPC envelopes, id handling, notifications, error codes (Tasks 1, 2)      | FAIL on any blocker or major                    |
| `security-reviewer`     | Auth bypass, token handling, leakage, PII gaps, ReDoS, secrets at rest (Tasks 2, 3, 4)        | FAIL on any critical or high                    |
| `spec-reviewer`         | Runs `npm run check`; verifies each acceptance criterion has asserting evidence               | FAIL on check failure, unmet criterion, blocker |

## Dry-run results

Each agent was run against a known-bad fixture with seeded defects. The fixtures were kept outside the repository and deleted afterwards.

| Agent                   | Fixture                                         | Seeded defects caught   | Notable extra findings                                                               |
| ----------------------- | ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `mcp-protocol-reviewer` | Hand-rolled stdio server                        | 7 / 7                   | Missing `initialize` / `tools/list`, crash on JSON `null`, non-strict schema         |
| `security-reviewer`     | HTTP gateway with redaction helper and SQLite   | 8 / 8                   | `Bearer constructor` prototype-lookup auth bypass; ReDoS timed at 5.7 s for 29 chars |
| `spec-reviewer`         | AC matrix with false ticks, weak test, bad code | 6 / 6                   | Leaked Zod message, missing sub-task log row                                         |
| `test-designer`         | Task 1 sub-task 1.2 (schemas)                   | All required edge cases | Float traps (`19.99 * 100`), `1e-7` defeating string-based decimal checks            |

The dry runs used the definitions' prompts through a general-purpose agent, because project agents are only registered when a session starts. The prompts are identical; only tool restriction was enforced by instruction instead of by configuration.

## Alternatives considered

- Reviews by the main session only: no consistent checklist, and the reviewer shares the author's context and blind spots.
- Agents with write access that fix what they find: mixes review with authorship and bypasses diff approval.

## Consequences

Reviews are repeatable and traceable. Findings feed the PR description's review notes. Agents can be wrong, so their findings are verified before acting on them.
