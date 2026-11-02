# 015: Tool behavior, mock data and refund logging

- Status: Accepted
- Source: [Spec] (two tools, validation) + [Decided] (results, failures, storage, logging)

## Context

The assessment defines the inputs of `get_customer_record` and `trigger_refund` but not their behavior. The server needs data to serve, a way to report outcomes that are valid requests but cannot succeed, and a rule for what refund details may be logged.

## Decision

- **Data** comes from an in-memory `CustomerRepository` (`src/customer-repository.ts`), seeded with four customers that cover each path:

  | Customer   | Status | Refundable balance |
  | ---------- | ------ | ------------------ |
  | CUST-00001 | active | 250.00             |
  | CUST-00002 | active | 0.00               |
  | CUST-00003 | closed | 100.00             |
  | CUST-00004 | active | 10,000.00          |

  State lasts for one server process. Each repository instance has its own copy, and lookups return copies.

- **Money is stored as integer cents** and shown as USD numbers with 2 decimals. Repeated refunds never drift: three refunds of 0.10 on 0.30 leave exactly 0. The repository also rejects non-positive or non-integer cents as a programming error (answered `-32603`), even though the schema already prevents them.
- **Results** carry the data twice: as JSON text in `content`, for display, and as `structuredContent`, for programmatic use. No `outputSchema` is published. Successful results omit `isError`.
- **Validation is centralized.** `ToolDefinition` requires an `args` Zod schema, and the server validates every call through `runTool` before the handler runs. Handlers receive typed, normalized input; a tool without a schema does not compile. Invalid arguments are protocol errors: `-32602 "Invalid params"`. Sub-task 1.4 adds field-level messages.
- **Business failures** are valid calls that cannot succeed, so they return a tool result with `isError: true` and a fixed message the model can act on. They are checked in this order:
  1. `Customer not found`
  2. `Customer account is closed`
  3. `Refund amount exceeds refundable balance`
- **Closed accounts** can still be read. Only refunds are refused.
- **Refund ids** are sequential per process (`REF-000001`, …). Failed refunds do not use one. Tests inject the generator.
- **Annotations:** `get_customer_record` is read-only. `trigger_refund` is destructive and not idempotent (every call creates a new refund). Neither reaches outside the server (`openWorldHint: false`).
- **Logging:**
  - A processed refund logs `customer_id`, `refund_id` and `amount`.
  - A rejected one logs `customer_id` and the failure code.
  - The `reason` text and customer email are never logged, because free text can carry personal data. The reason is echoed in the result, where it is the client's own data.

## Alternatives considered

- JSON-RPC errors for business failures: the model would see a protocol failure instead of an outcome it can explain or recover from. MCP reserves `isError` for exactly this case.
- Dollar floats in storage: `0.1 + 0.2` style drift across repeated refunds.
- An on-disk store: unnecessary for a mock server, and Task 4 already covers SQLite.
- Logging the full refund request: useful for debugging, but it writes free-text personal data to logs.

## Consequences

Restarting the server resets all balances. Concurrency is safe within one process, because handlers run synchronously on the event loop: two pipelined refunds cannot overdraw an account, and a test proves it. A real backend would need its own transactional guarantee.
