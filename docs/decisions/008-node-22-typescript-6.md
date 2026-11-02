# 008: Node 22.12+ baseline, TypeScript pinned to 6.0

- Status: Accepted
- Source: [Decided]

## Context

- Node 20 reached end of life in April 2026.
- The current majors of `better-sqlite3` (13.x) and `vitest` (5.x) require Node 22 or newer.
- TypeScript 7 (the native port) is released, but `typescript-eslint` supports TypeScript `<6.1`.

## Decision

- `engines.node` is `>=22.12`; `.nvmrc` is `22`. CI runs Node 22 and 24.
- TypeScript is pinned to the 6.0 line so type-checked ESLint rules work.
- Dependencies are installed with exact versions.

## Alternatives considered

- Keep Node 20 and pin older majors (`better-sqlite3` 12, `vitest` 4): supports an unmaintained runtime.
- TypeScript 7 without type-checked lint rules: loses the main value of linting TypeScript.

## Consequences

Reviewers need Node 22.12 or newer. The TypeScript pin is revisited when `typescript-eslint` supports 7.
