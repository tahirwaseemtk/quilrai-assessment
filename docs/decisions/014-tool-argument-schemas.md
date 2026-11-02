# 014: Tool argument schemas and hand-written JSON Schema

- Status: Accepted
- Source: [Spec] (formats and minimums) + [Decided] (bounds, normalization, export)

## Context

The assessment specifies `customer_id` as `CUST-XXXXX`, `amount` as a positive float, and `reason` as at least 10 characters. Several edge cases are left open: an upper bound, decimal precision, whitespace and invisible characters, how length is counted, and how the schemas are published in `tools/list`.

## Decision

Zod schemas in `task1-mcp-server/src/schemas.ts`, all strict objects (unknown keys rejected):

| Field         | Rule                                                                                                                                                     | Source         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `customer_id` | String matching `^CUST-[0-9]{5}$`: ASCII digits only, no trimming                                                                                        | Spec           |
| `amount`      | Finite number, `> 0`, `<= 10000`, at most 2 decimal places                                                                                               | Spec + Decided |
| `reason`      | String of at most 500 code points as sent. Surrounding whitespace and invisible characters are trimmed, then at least 10 visible code points must remain | Spec + Decided |

- **Two decimals** is checked as `Number(value.toFixed(2)) === value`. It accepts doubles such as `19.99` (stored as 19.98999…) and rejects `1.005`, `10.001` and `1e-7`; a `value * 100` integer check misjudges float representation. Float arithmetic that is not exactly 2 decimals, such as `0.1 + 0.2`, is rejected. Clients must round to cents, and the field description says so.
- **Invisible characters** means Unicode `Default_Ignorable_Code_Point`: zero-width characters, bidi controls, soft hyphen, word joiner, BOM, Hangul filler and similar. A hand-written list missed several of them.
- **Trimming touches only the edges.** Invisible characters inside the text are kept, because emoji ZWJ sequences and ZWNJ in Persian and Indic scripts carry meaning, but they do not count toward the minimum. Ten zero-width spaces are rejected; the family emoji (man, ZWJ, woman, ZWJ, girl) and Persian text reach the handler unchanged. This refines the agreed "strip before counting" rule so that legitimate text is never altered.
- **Linear-time trimming:** the edges are trimmed by scanning code points, not with an end-anchored regex, which backtracked quadratically: 40,000 spaces before a letter took about 1 s. The raw-length check aborts first, so oversized input is never normalized. A regression test parses a 1 MB padded reason within a 500 ms budget.
- **Lengths are counted in code points**, matching JSON Schema `minLength` / `maxLength`. `"😀" × 10` is 10 characters.
- **The maximum applies to the raw string** and the minimum to the visible, trimmed string. As a result, the server never accepts a `reason` that the published `maxLength` rejects.
- **No coercion:** `"10"` is not an amount.

JSON Schema in `task1-mcp-server/src/tool-schemas.ts` is hand-written from the same constants:

- It includes `pattern`, `exclusiveMinimum: 0`, `maximum`, `minLength`, `maxLength`, `required` and `additionalProperties: false`. The descriptions state the rules JSON Schema cannot express: 2 decimals, rounding, visible length and trimming.
- It has no `$schema` key and no `multipleOf: 0.01`, because float `multipleOf` is unreliable across validators.
- Parity tests evaluate the published schema with a small validator for these keywords:
  - `customer_id` must agree with Zod in both directions.
  - For `amount` and `reason`, every value Zod accepts must pass the schema. The server may be stricter than the schema, never looser.

Source files must not contain literal invisible characters. Tests build them with `String.fromCodePoint`, and a hygiene test enforces this.

## Alternatives considered

- `z.toJSONSchema`: drops refinements (2 decimals, code-point and visible length), and the normalization is not represented.
- No upper bounds: lets `1e21` or a 1 MiB reason through the schema.
- Removing invisible characters everywhere: breaks emoji ZWJ sequences and ZWNJ-dependent scripts.
- A fixed blocklist of zero-width characters: missed soft hyphen, LRM, bidi overrides, U+2061 and the Hangul filler.

## Consequences

The JSON Schema is advisory for clients and the Zod schema is authoritative. A client whose input passes the JSON Schema can still be rejected for more than 2 decimals or for a reason without 10 visible characters, and the descriptions say so. The reverse cannot happen.

The published schemas use draft-06+ keywords: numeric `exclusiveMinimum`, which is valid in the MCP default dialect (2020-12) and in draft-07. A draft-04-only validator would misread it. `[0-9]` is used instead of `\d` because Python `re`-based validators treat `\d` as any Unicode digit. Python's `$` also matches before a trailing newline, so such validators may accept `"CUST-12345\n"`, which the server rejects. That is the allowed direction.
