# 006: LF line endings enforced via `.gitattributes`

- Status: Accepted
- Source: [Decided]

## Context

Development happens on Windows. MCP stdio framing is newline-delimited JSON, and SSE framing depends on exact line endings. With CRLF checkouts, test fixtures and expected outputs can differ by platform.

## Decision

`.gitattributes` sets `* text=auto eol=lf`, so every text file is LF in the repo and in every checkout.

## Alternatives considered

- Relying on each developer's `core.autocrlf` setting: inconsistent across machines and CI runners.

## Consequences

Fixtures and snapshots are byte-identical on Windows and Linux CI.
