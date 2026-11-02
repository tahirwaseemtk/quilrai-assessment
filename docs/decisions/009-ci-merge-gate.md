# 009: CI merge gate on every PR

- Status: Accepted
- Source: [Decided]

## Context

Only reviewed, passing work may reach `taskN/main` or `main`. Development happens on Windows, while reviewers and CI usually run Linux. The stdio and SSE tasks are sensitive to platform differences such as line endings and process spawning.

## Decision

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` and `task*/main`:

- `check`: `npm ci` then `npm run check` (typecheck, lint, format check, tests) on a matrix of `ubuntu-latest` and `windows-latest` × Node 22 and 24.
- `audit`: `npm audit --omit=dev --audit-level=high` on production dependencies.
- `ci-ok`: aggregates both jobs into one status, so branch protection names a single check that does not change when the matrix does.

Hardening: read-only `contents` permission, actions pinned to commit SHAs, `persist-credentials: false`, job timeouts, and superseded runs cancelled.

Branch protection on `main` and `task*/main` (set by the repo owner in GitHub settings):

- Require a pull request before merging
- Require status check `ci-ok` to pass, with the branch up to date before merging
- Block force pushes and deletions

## Alternatives considered

- Ubuntu only: faster, but misses the Windows-specific failures that this repo is most exposed to.
- Requiring each matrix job by name: breaks branch protection whenever the matrix changes.
- Dev dependencies in the audit: the known dev-only `minimatch` advisory would block every merge with no available fix.

## Consequences

Each PR takes the time of the slowest matrix job. A new high-severity advisory in a production dependency blocks merges until it is addressed.
