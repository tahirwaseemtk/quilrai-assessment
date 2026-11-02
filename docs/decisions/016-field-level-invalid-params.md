# 016: Field-level Invalid params messages

- Status: Accepted
- Source: [Spec] (fixed field-level `-32602` messages, no Zod internals) + [Decided] (format and rules)

## Context

AC1.3 requires invalid tool arguments to return `-32602` with a fixed message that names the failing field, without Zod issue text or stack traces. Until 1.4 every argument failure returned plain `Invalid params`, which is correct but tells the client nothing actionable.

## Decision

- **Format:** `Invalid params: <fragment>; <fragment>`. Each fragment comes from a closed set in `src/field-errors.ts` (`ArgumentMessage`), built from the same constants as the schemas (including `CUSTOMER_ID_DIGITS`). `src/errors.ts` stays protocol-only:

  | Fragment                                                                                 | When                                                 |
  | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
  | `customer_id must match CUST-XXXXX (5 digits)`                                           | `customer_id` present but invalid (including `null`) |
  | `amount must be a number greater than 0 and at most 10000 with at most 2 decimal places` | `amount` present but invalid                         |
  | `reason must be a string of at most 500 characters with at least 10 visible characters`  | `reason` present but invalid                         |
  | `customer_id is required`, `amount is required`, `reason is required`                    | field absent                                         |
  | `unknown arguments are not allowed`                                                      | any extra key                                        |
  | `arguments must be an object`                                                            | non-object arguments reaching a tool; always alone   |

- **Ordering:** field fragments follow the schema's field order, not the input's, and unknown keys come last. Duplicate Zod issues for one field (for example `too_small` plus the 2-decimal refinement) produce one fragment.
- **Nothing is echoed:** the message never contains client input, including unknown key names, which can carry arbitrary or injected text.
- **Missing vs invalid** is decided from the raw arguments (`Object.hasOwn`), because Zod issues do not carry the input.
- **Omitted `arguments`** is treated as `{}`, since MCP makes `arguments` optional. The client is told which fields are required.
- **Fallback:** if any issue maps to no known field, the whole message falls back to plain `Invalid params`, so a partial list never misdescribes the error. A tool that declares no `argumentFields` always gets the plain message, even for unknown keys. A key set to `undefined` counts as missing.
- **Outbound allowlist:** `sanitizeOutbound` accepts a `-32602` message beyond the fixed ones only if it is the prefix plus known fragments joined by `; `, using each slot at most once: a field cannot be both "required" and "must …", and `arguments must be an object` stands alone. The check is a linear `split`. Anything else, such as a tampered separator, a duplicate, a contradictory pair, a lookalike character, extra text or a fragment under another code, becomes the canonical message for its code.
- **Unchanged:** envelope-level problems found before a tool runs (missing `name`, non-object `arguments` on the wire, SDK schema failures) stay plain `Invalid params`.
- **Own `__proto__` argument key:** the SDK, and Zod when it copies objects, silently drop an own `__proto__` key that `JSON.parse` creates, so the strict tool schemas would never report it and the call could succeed. `src/inbound.ts` checks the raw object first and answers plain `Invalid params` (a notification carrying it is dropped).

## Alternatives considered

- Zod's own issue messages: they include internal codes and expected types, and they change between Zod versions.
- Details in `error.data`: the sanitizer drops `data` by design, and clients surface `message` more readily.
- Echoing unknown key names: helpful, but it reflects arbitrary client text into responses that a model may read.
- Reporting only the first invalid field: forces one round trip per mistake.

## Consequences

The set of possible wire messages stays closed and testable. Adding a field means adding two fragments to `ArgumentMessage` and registering both in `fragmentSlots`; a test fails if any fragment has no slot. Messages repeat the limits in `src/schemas.ts`, because the fragments are built from the same constants.
