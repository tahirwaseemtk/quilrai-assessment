# 025: Redaction detection limits and known misses

- Status: Accepted
- Source: [Spec] (the three PII kinds and their formats) + [Decided] (what is deliberately not detected)

## Context

Regex redaction is precise for well-formed values and blind to anything that is not written in the expected shape. The assessment asks for three PII kinds in their standard forms. Anything else is a known miss, and the reviewer should see it stated.

## Decision

Detection covers exactly:

- Email addresses in the form `local@domain.tld`.
- US SSNs written `###-##-####`, with invalid area numbers excluded.
- Card numbers of 13–19 digits, separated by at most one space or dash between digits, that pass the Luhn check.

Known misses (accepted):

- **Obfuscated addresses:** `john at example dot com`, `john[at]example.com`, and addresses with spaces inside them.
- **SSNs without dashes:** `123456789` is not redacted, because the spec's format has dashes and redacting every nine-digit number would destroy ordinary numbers.
- **Cards with unusual separators:** double spaces, dots, or a mix such as `4111 - 1111`.
- **Cards that fail Luhn:** kept as text, unless a valid 13–19 digit span lies inside them, in which case that span is redacted (fail-closed). A card with a typo is not sensitive in the same way.
- **Card-shaped text inside longer runs:** a valid card inside a longer digit run is redacted, so a 20-digit run can be partly redacted. This is a deliberate fail-closed choice.
- **Non-ASCII digits and letters:** emails with internationalized characters are not matched.
- **Long digit-and-space runs:** a run longer than the holdback cap (768 characters) is emitted in pieces, so a card inside such a run may not be redacted. Runs of this length do not occur in normal answers.
- **Non-text delta fields are dropped:** tool-call arguments, refusals and reasoning text are not forwarded at all, so they cannot leak. Usage-only chunks are dropped as well.
- **Values that the model rewrites:** the redactor sees the text the provider streams. If the model writes a card number in words, nothing is matched.
- **Prompts are not redacted:** only the answer is filtered.

## Alternatives considered

- **Loose patterns (any nine digits, any `@`):** catches more, but corrupts ordinary text and makes the output hard to trust. Rejected.
- **A named-entity or ML detector:** broader coverage, but a new dependency, which CLAUDE.md forbids without approval, and it adds latency.

## Consequences

- The reviewer can see exactly which inputs leak. The manual test guide lists them so that they can be tried.
