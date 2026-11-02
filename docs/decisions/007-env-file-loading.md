# 007: Env loading via Node `--env-file-if-exists`

- Status: Accepted
- Source: [Decided]

## Context

Tasks 2 to 4 read ports, URLs, tokens, and limits from the environment. Secrets must stay out of the repo; only `.env.example` is committed.

## Decision

Task scripts run `tsx --env-file-if-exists=.env <entry>`. Each task parses `process.env` with a Zod schema at startup and fails fast with a clear message (no secret values in it) when something is missing or invalid. Every variable has a safe local default, so tasks also run without a `.env` file.

## Alternatives considered

- `dotenv`: an extra dependency for a feature Node already has.

## Consequences

No runtime dependency for config. Tests pass config objects directly and never read `.env`.
