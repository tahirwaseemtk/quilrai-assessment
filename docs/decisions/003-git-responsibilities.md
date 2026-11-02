# 003: Claude commits after approval; human pushes and merges

- Status: Accepted
- Source: [Decided]

## Context

Development is AI-assisted. The repository owner must stay in control of what reaches the remote and `main`.

## Decision

- Claude creates branches and commits only after the owner approves the diff and the commit message.
- Claude never pushes, opens PRs, or merges.
- The owner pushes, opens PRs, and merges. `main` and `taskN/main` are protected on GitHub: PR required, CI must pass.

## Alternatives considered

- Claude runs no git commands: safe, but slow given about 25 sub-task branches.
- Claude also merges locally: faster, but removes the PR review step.

## Consequences

Every change in history has been reviewed by the owner before it was committed and again in its PR.
