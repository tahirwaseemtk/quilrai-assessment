# Decision log

One file per decision, named `NNN-short-title.md`. Source is `[Spec]` when the assessment requires it and `[Decided]` when it is a design choice.

| #                                       | Decision                                               | Source  | Status   |
| --------------------------------------- | ------------------------------------------------------ | ------- | -------- |
| [001](001-single-package-root-tasks.md) | Single npm package, task folders at the repo root      | Decided | Accepted |
| [002](002-branch-naming.md)             | Branch naming `taskN/main` and `taskN/N.M-slug`        | Decided | Accepted |
| [003](003-git-responsibilities.md)      | Claude commits after approval; human pushes and merges | Decided | Accepted |
| [004](004-test-first-workflow.md)       | Test-first sub-task loop with staged reviews           | Decided | Accepted |
| [005](005-lint-no-console.md)           | ESLint `no-console` allowing only `console.error`      | Decided | Accepted |
| [006](006-lf-line-endings.md)           | LF line endings enforced via `.gitattributes`          | Decided | Accepted |
| [007](007-env-file-loading.md)          | Env loading via Node `--env-file-if-exists`            | Decided | Accepted |
| [008](008-node-22-typescript-6.md)      | Node 22.12+ baseline, TypeScript pinned to 6.0         | Decided | Accepted |

## Template

```markdown
# NNN: Title

- Status: Accepted
- Source: [Spec] | [Decided]

## Context

## Decision

## Alternatives considered

## Consequences
```
