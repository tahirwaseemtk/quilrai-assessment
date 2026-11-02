# 002: Branch naming `taskN/main` and `taskN/N.M-slug`

- Status: Accepted
- Source: [Decided]

## Context

Each task has an integration branch, and each sub-task gets its own branch merged into it. Git stores refs as paths, so a branch `task/1-mcp-server` cannot coexist with `task/1-mcp-server/1.2-zod-schemas`.

## Decision

- Task integration branch: `taskN/main` (for example, `task1/main`).
- Sub-task branch: `taskN/N.M-short-slug` (for example, `task1/1.2-zod-schemas`), created from `taskN/main`.
- Supporting work: `chore/<slug>` and `docs/<slug>`, created from `main`.
- Sub-task branches merge into `taskN/main` through a PR with `--no-ff`. Only a finished, reviewed `taskN/main` merges into `main`.
- Commit messages: `taskN.M: <imperative summary>`.

## Alternatives considered

- `task/1-mcp-server` with nested sub-task branches: invalid in git (ref file/directory conflict).
- Sub-tasks committed straight to the task branch: loses per-sub-task PR review.

## Consequences

Every sub-task has a reviewable PR, and `git log --first-parent taskN/main` reads as the list of sub-tasks.
