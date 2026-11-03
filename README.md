# QuilrAI Assessment: MCP & LLM Gateway Tasks

Four independent TypeScript solutions for the QuilrAI AI Field Developer / Solutions Engineer assessment.

## Prerequisites

Node 22.12+ and npm 10+.

## Quick start

```sh
npm ci
cp .env.example .env   # optional: tasks run with safe local defaults
npm run check          # typecheck + lint + format check + all tests
```

## Tasks

| #   | Task                                         | Run                                           | Status  | Docs                                           |
| --- | -------------------------------------------- | --------------------------------------------- | ------- | ---------------------------------------------- |
| 1   | Stdio MCP server with strict validation      | `npm run task1`                               | Done    | [docs](docs/task1-mcp-server/README.md)        |
| 2   | MCP security gateway (auth + tool filtering) | `npm run task2:mock` then `npm run task2`     | Done    | [docs](docs/task2-mcp-gateway/README.md)       |
| 3   | Streaming PII redaction guardrail            | `npm run task3:provider` then `npm run task3` | Done    | [docs](docs/task3-stream-guardrail/README.md)  |
| 4   | Token rate limiter + model fallback (SQLite) | _pending_                                     | Planned | [docs](docs/task4-rate-limit-router/README.md) |

## Repo conventions

- Design decisions: [docs/decisions](docs/decisions/README.md)
- Branching: `taskN/main` ← `taskN/N.M-slug` via PR; `main` only receives finished tasks.
- Each task folder: `index.ts` entry, `src/`, `test/`.
- Review subagents (read-only): [.claude/agents](.claude/agents/), see [ADR 011](docs/decisions/011-project-review-subagents.md).
