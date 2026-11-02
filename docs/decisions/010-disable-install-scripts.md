# 010: Disable dependency install scripts via `.npmrc`

- Status: Accepted
- Source: [Decided]

## Context

`better-sqlite3` 13 ships prebuilt N-API binaries for every supported platform and declares `"gypfile": false`. The npm 10 bundled with Node 22 ignores that flag and runs an implicit `node-gyp rebuild` because the package contains `binding.gyp`. The rebuild is never needed, because the module loads from `prebuilds/`, but it requires a C++ toolchain. On the `windows-latest` runner, node-gyp 11 does not recognize the installed Visual Studio 2026, so `npm ci` failed on Windows + Node 22. npm 11 (Node 24) respects the flag. Any reviewer on Windows with Node 22 and no Visual Studio would hit the same failure.

The other packages with install scripts are optional to run:

- `esbuild`: resolves its binary from a platform-specific optional dependency; its postinstall only verifies it.
- `fsevents`: macOS only, and prebuilt.

## Decision

A repo-level `.npmrc` sets `ignore-scripts=true` (no dependency lifecycle scripts) and `engine-strict=true` (refuse to install on Node versions below `engines.node`). CI smoke-tests the `better-sqlite3` binding after `npm ci` on every matrix cell.

## Alternatives considered

- Upgrade npm to 11 in CI: fixes CI only; reviewers on Node 22 still fail.
- Install Visual Studio build tools on the runner: slow, and compiles something that is already prebuilt.
- `--ignore-scripts` on the CI command only: same reviewer problem as upgrading npm.

## Consequences

- Installs are faster and deterministic across npm 10 and 11, and dependencies cannot run code at install time (supply-chain hardening).
- `npm run <script>` and `npm test` still work; only pre/post hooks and dependency lifecycle scripts are skipped.
- A future dependency that genuinely needs an install script must be approved and run explicitly (`npm rebuild <pkg>`), and this ADR updated.
