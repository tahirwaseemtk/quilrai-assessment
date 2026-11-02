# 001: Single npm package, task folders at the repo root

- Status: Accepted
- Source: [Decided]

## Context

The assessment has four independent tasks. The reviewer should clone once, install once, and run each task with one command.

## Decision

One `package.json` and lockfile at the root. Each task lives in `taskN-<name>/` with `index.ts`, `src/`, and `test/`. Code shared by two or more tasks goes in `shared/`.

## Alternatives considered

- npm workspaces, one package per task: cleaner isolation, but four lockfile entries, duplicated configs, and more setup for the reviewer.
- A single `src/` tree with a mirrored `test/` tree: splits each task across two distant folders.

## Consequences

All tasks share dependency versions and one tsconfig. A task's folder is self-contained to read and review.
