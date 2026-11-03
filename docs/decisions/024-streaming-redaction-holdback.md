# 024: Streaming PII redaction with a prefix-aware holdback

- Status: Accepted
- Source: [Spec] (chunk-by-chunk streaming, emails, SSNs as `###-##-####`, Luhn-valid 13–19 digit cards as `[REDACTED]`, `TextDecoder` with `stream: true`, bounded regexes, backpressure, upstream abort) + [Decided] (holdback rule, cap, pipeline layout)

## Context

A redactor that waits for the whole answer, or holds a fixed 768 characters, adds latency to every stream and hurts time to first token. A redactor that emits each delta as it arrives can split a card number or an address across two frames and leak it. The holdback has to be just large enough to keep any possible match together, and no larger.

## Decision

- **Pipeline:** provider bytes → `TextDecoder` with `stream: true` → SSE payload parser (its own line buffer, LF / CRLF / CR) → chunk parser (Zod) → `StreamingRedactor` → SSE encoder. Each stage is an async generator or a pure function and is tested on its own.
- **Holdback rule.** After each delta, the buffer's trailing text is checked against two end-anchored patterns: a possible email (a local part, optionally followed by `@` and a partial domain) and a possible card or SSN (digits with at most one space or dash between digits). Everything before the earliest such start is emitted, after full matches are redacted. Only that trailing text is held.
- **The cap is derived, not chosen:** `MAX_HOLDBACK = max(email length, card length, SSN length)` = 768 characters (the longest email: 64 local characters, 703 domain characters). Held text can never exceed it.
- **Runs, not guessed prefixes:** the held text is the trailing run of email characters (letters, digits, `._%+-@`) or of card characters (digits, spaces, dashes, starting at a digit). A run is held whole, so two cards separated by one space are one run and are redacted together. Ordinary prose ends in a space or punctuation, so it is emitted at once. A word at the very end of a delta is held until the next delimiter, because `now` could still be the start of `now@x.com`.
- **Full-match rules:**
  - Email: local part 1–64 characters from `[A-Za-z0-9._%+-]`; domain labels of 1–63 characters, 2–11 labels.
  - SSN: `###-##-####` with area 000, 666 and 900–999 excluded.
  - Card: a run of digits with optional single spaces or dashes between them; inside the run, each 13–19 digit span that passes Luhn is redacted, longest first from the left. Holding the whole run keeps back-to-back cards together.
- **Whole-text equivalence:** the streaming output must equal `redactText(whole text)` for every split point. The tests check every two-way split, 500 seeded three-way splits, and every byte split of the SSE stream.
- **Regexes:** bounded quantifiers only, no nesting. Tested against 100 KB inputs, which must finish in under 250 ms.
- **Stream handling:** a stream ends with a flush of the held text and `data: [DONE]`. Writes wait on `drain`, and a client that closes stops the provider through `AbortController`. Only `model`, `messages` and `stream` are forwarded to the provider.

## Alternatives considered

- **Hold a fixed 768 characters:** correct, but every answer waits, and TTFT suffers on prose. Rejected.
- **Buffer the whole answer:** simplest and complete, but it breaks streaming and makes memory grow with the answer. Rejected.
- **Emit each delta and redact only full matches:** the split-number leak the spec warns about. Rejected.
- **Hold back at the last whitespace:** simpler, but it holds an entire sentence and does not tie the holdback to the pattern lengths. Rejected.
- **Regex over the full text with a sliding window:** same coverage, but harder to prove equal to the whole-text result.

## Consequences

- Peak holdback is at most 768 characters for any stream length (tested with a 10 MB stream).
- Coverage misses are listed in ADR 025.
