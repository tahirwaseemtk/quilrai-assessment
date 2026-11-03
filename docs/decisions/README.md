# Decision log

One file per decision, named `NNN-short-title.md`. Source is `[Spec]` when the assessment requires it and `[Decided]` when it is a design choice.

| #                                             | Decision                                                     | Source         | Status   |
| --------------------------------------------- | ------------------------------------------------------------ | -------------- | -------- |
| [001](001-single-package-root-tasks.md)       | Single npm package, task folders at the repo root            | Decided        | Accepted |
| [002](002-branch-naming.md)                   | Branch naming `taskN/main` and `taskN/N.M-slug`              | Decided        | Accepted |
| [003](003-git-responsibilities.md)            | Claude commits after approval; human pushes and merges       | Decided        | Accepted |
| [004](004-test-first-workflow.md)             | Test-first sub-task loop with staged reviews                 | Decided        | Accepted |
| [005](005-lint-no-console.md)                 | ESLint `no-console` allowing only `console.error`            | Decided        | Accepted |
| [006](006-lf-line-endings.md)                 | LF line endings enforced via `.gitattributes`                | Decided        | Accepted |
| [007](007-env-file-loading.md)                | Env loading via Node `--env-file-if-exists`                  | Decided        | Accepted |
| [008](008-node-22-typescript-6.md)            | Node 22.12+ baseline, TypeScript pinned to 6.0               | Decided        | Accepted |
| [009](009-ci-merge-gate.md)                   | CI merge gate on every PR (`ci-ok` required check)           | Decided        | Accepted |
| [010](010-disable-install-scripts.md)         | Disable dependency install scripts via `.npmrc`              | Decided        | Accepted |
| [011](011-project-review-subagents.md)        | Read-only project review subagents, dry-run verified         | Decided        | Accepted |
| [012](012-low-level-server-rpc-errors.md)     | Low-level SDK `Server` with fixed-message `RpcError`         | Spec + Decided | Accepted |
| [013](013-custom-line-transport.md)           | Custom stdio line transport                                  | Spec + Decided | Accepted |
| [014](014-tool-argument-schemas.md)           | Tool argument schemas and hand-written JSON Schema           | Spec + Decided | Accepted |
| [015](015-tool-behavior-mock-data.md)         | Tool behavior, mock data and refund logging                  | Spec + Decided | Accepted |
| [016](016-field-level-invalid-params.md)      | Field-level Invalid params messages                          | Spec + Decided | Accepted |
| [017](017-shared-logger-service-tagging.md)   | Shared stderr logger with per-service tagging                | Decided        | Accepted |
| [018](018-mock-downstream-mcp-server.md)      | Mock downstream MCP server                                   | Spec + Decided | Accepted |
| [019](019-gateway-client-auth.md)             | Gateway client authentication and role config                | Spec + Decided | Accepted |
| [020](020-gateway-envelope-classification.md) | Gateway envelope classification and shared JSON-RPC envelope | Spec + Decided | Accepted |
| [021](021-gateway-http-layer.md)              | Gateway HTTP layer and passthrough proxy                     | Spec + Decided | Accepted |
| [022](022-gateway-admin-gate.md)              | Gateway admin gate and tool-name check                       | Spec + Decided | Accepted |

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
