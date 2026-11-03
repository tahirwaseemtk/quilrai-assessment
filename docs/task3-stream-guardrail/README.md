# Task 3: Streaming PII redaction guardrail

Status: Done (3.1 to 3.7 implemented in one pass on `task3/main`; see the log below).

## Setup and run

```sh
npm ci
cp .env.example .env          # set LLM_PROVIDER_API_KEY (any value for the stub)
npm run task3:provider        # stub OpenAI-compatible provider on 127.0.0.1:8091
npm run task3                 # guardrail on 127.0.0.1:8090
npm run test:task3
```

The stub echoes the last user message as a streamed answer, so PII in a prompt comes back as the answer. The gateway forwards only `model`, `messages` and `stream` to the provider. A client-supplied `Authorization` header is never forwarded; the gateway sends its own `LLM_PROVIDER_API_KEY`.

## Design

```
client ── POST /v1/chat/completions ──► guardrail
                                          │  fetch (stream: true), Authorization: gateway key
                                          ▼
provider SSE bytes ─► TextDecoder(stream) ─► SSE payload parser ─► chunk parser (Zod)
                                                     │
                                                     ▼
                              StreamingRedactor (prefix-aware holdback, ADR 024)
                                                     │
                                                     ▼
                              SSE encoder ─► client (writes wait on drain)
```

- **Redaction:** emails, SSNs (`###-##-####`, areas 000, 666 and 900–999 excluded) and Luhn-valid 13–19 digit cards (one space or dash between digits) become `[REDACTED]`. Rules and known misses: ADR 024 and ADR 025.
- **Holdback:** only the trailing text that could still become a match is held, capped at `MAX_HOLDBACK` = 768 characters, the longest email (11 labels of 63 characters). Ordinary prose is emitted at once.
- **Cancellation:** a client that disconnects aborts the provider request through `AbortController`, so generation stops.
- **Backpressure:** writes wait for `drain`. A client that closes while waiting stops the stream.
- **Logs:** one `request` line per call (`http_method`, `status`, `duration_ms`). No prompt, answer, key or provider URL is logged.

## Acceptance criteria

- [x] **AC3.1** `POST /v1/chat/completions` with `stream: true` proxies to the provider and re-emits SSE `data:` frames ending in `data: [DONE]`. `guardrail.test.ts` "redacts PII in the streamed answer and ends with [DONE]"; `config-and-e2e.test.ts` (spawned entry, end to end).
- [x] **AC3.2** Emails, SSNs and Luhn-valid cards become `[REDACTED]`; invalid areas, short and long digit runs, and Luhn-invalid numbers are left alone; a valid card inside a longer digit run is redacted (fail-closed). `redactor.test.ts` "redactText" (kinds, false positives).
- [x] **AC3.3** No PII survives any split. Every two-way split point, 500 seeded three-way splits, and every byte split of the SSE stream give the whole-text result. `redactor.test.ts` "streaming redactor"; `guardrail.test.ts` "never lets PII through at any byte split of the SSE bytes". Multibyte characters split across bytes are decoded whole (`sse.test.ts`).
- [x] **AC3.4** Held text stays at or below `MAX_HOLDBACK` for a 10 MB stream. Checked by `peakHeld` (`guardrail.test.ts` "keeps the held text bounded for a 10 MB stream"), not by heap size. Regexes are bounded and finish 100 KB pathological inputs in under 250 ms (`redactor.test.ts` "ReDoS safety").
- [x] **AC3.5** For PII-free prose ending in a space or punctuation, the text is emitted with no holdback (a word at the very end of a delta waits for the next delimiter). The first frame arrives within 1 s of the request (`guardrail.test.ts` "sends the first redacted text before the provider finishes"): `redactor.test.ts` "emits ordinary prose at once"; and the first frame reaches the client before the provider finishes (`guardrail.test.ts` "sends the first redacted text before the provider finishes").

Additional behavior with evidence:

- Backpressure: a slow reader gets the full, redacted text and the provider is not aborted (`guardrail.test.ts` "keeps every character when the client reads slowly").
- Upstream abort on client disconnect (`guardrail.test.ts` "stops the provider when the client disconnects").
- Request validation and 404, 405, 413 (`guardrail.test.ts` "request validation").
- Sanitized 502 when the provider is unreachable, with no URL or port in the body (`guardrail.test.ts` "failures").
- Config validation and fixed error fields (`config-and-e2e.test.ts`).

## Tradeoffs: holdback size, coverage and latency

| Choice                             | Coverage                                | Latency                                                                   | Memory                |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- | --------------------- |
| No holdback (emit each delta)      | Misses any PII split across deltas      | None                                                                      | Constant              |
| Holdback = trailing word (current) | Catches every split email, SSN and card | Only a word without a trailing space is delayed, until the next delimiter | ≤ 768 characters      |
| Fixed 768-character holdback       | Same coverage                           | Every answer delayed by up to 768 characters                              | Fixed 768             |
| Buffer the whole answer            | Complete                                | Full answer delay; TTFT lost                                              | Grows with the answer |

The current rule keeps the trade-off small: detection is as strong as the fixed holdback, and prose streams with no delay. The price is that a word at the end of a delta waits for the next space or punctuation, which is a visible but short pause.

## Known limits

Listed in ADR 025 and tested only as misses: obfuscated addresses (`john at example dot com`), SSNs without dashes, cards with unusual separators, cards that fail Luhn, non-ASCII addresses, values the model writes out in words, and prompts (only the answer is filtered).

## Sub-task log

| Sub-task                       | Changed                                                           | Why                                                                                    | Verified                                                |
| ------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 3.1 Matchers and Luhn          | `src/patterns.ts`, `src/luhn.ts`                                  | Pure, testable detection rules; holdback cap derived from the lengths                  | `redactor.test.ts` "luhn", "redactText"                 |
| 3.2 Streaming redactor         | `src/redactor.ts` (holdback), ADR 024                             | Emit prose at once; hold only possible matches                                         | `redactor.test.ts` "streaming redactor", "ReDoS safety" |
| 3.3 Boundary and UTF-8         | `test` only; the CRLF fix is in `src/sse.ts` under 3.4            | Exhaustive two-way splits, seeded three-way splits, byte splits                        | `redactor.test.ts`, `sse.test.ts`, `guardrail.test.ts`  |
| 3.4 SSE parser and encoder     | `src/sse.ts`                                                      | Line buffer with LF, CRLF and CR; Zod on chunks                                        | `sse.test.ts`                                           |
| 3.5 Endpoint and provider stub | `src/guardrail.ts`, `src/config.ts`, `index.ts`, `stub-provider/` | Proxy with the gateway key, drain-aware writes, abort on disconnect                    | `guardrail.test.ts`, `config-and-e2e.test.ts`           |
| 3.6 Memory, latency, ReDoS     | tests only                                                        | Bounded holdback for 10 MB; under 250 ms for 100 KB inputs; first frame before the end | `guardrail.test.ts`, `redactor.test.ts`                 |
| 3.7 Docs                       | this file, ADR 024, ADR 025, `.env.example`, root README          | Record the design and its limits                                                       | —                                                       |

Defects found and fixed while testing: the SSE line splitter kept `\r` on CRLF lines, so blank lines never dispatched an event (`sse.test.ts`); the stub built a character array per response, too heavy for a 10 MB stream.

---

## Manual testing guide

Run these from Git Bash in the repo root. Set `LLM_PROVIDER_API_KEY` in `.env` first (any value works with the stub).

### 1. Start the services

Terminal 1:

```sh
npm run task3:provider
```

Terminal 2:

```sh
npm run task3
```

You should see a `listening` line with `"service":"task3-stream-guardrail"`. Nothing should appear on stdout.

### 2. Set up Terminal 3

```sh
G=http://127.0.0.1:8090/v1/chat/completions
H='content-type: application/json'
```

### 3. Run the checks

| #   | Command                                                                                                                                                     | Expected                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `curl -sN -X POST $G -H "$H" -d '{"model":"stub","stream":true,"messages":[{"role":"user","content":"Email john.doe@example.com about SSN 123-45-6789"}]}'` | An SSE stream of `data:` frames. The joined answer reads `Email [REDACTED] about SSN [REDACTED]`. The stream ends with `data: [DONE]`. |
| 2   | Same as 1, with content `Card 4111 1111 1111 1111 and 4111-1111-1111-1111`                                                                                  | Both cards show as `[REDACTED]`.                                                                                                       |
| 3   | Content `Card 4111 1111 1111 1112` (Luhn-invalid)                                                                                                           | The number is returned as written.                                                                                                     |
| 4   | Content `SSN 000-12-3456`                                                                                                                                   | Returned as written (invalid area).                                                                                                    |
| 5   | Content `Hello there, how are you today?`                                                                                                                   | Frames arrive immediately; the text is unchanged.                                                                                      |
| 6   | `curl -sN -X POST $G -H "$H" -d '{"model":"stub","stream":false,"messages":[{"role":"user","content":"hi"}]}'`                                              | 400, `{"error":{"code":"INVALID_REQUEST",...}}`.                                                                                       |
| 7   | `curl -s -X POST $G -H "$H" -d '{nope'`                                                                                                                     | 400, `INVALID_REQUEST`.                                                                                                                |
| 8   | `curl -s -i http://127.0.0.1:8090/nope -X POST`                                                                                                             | 404.                                                                                                                                   |
| 9   | Stop the provider (Terminal 1, Ctrl+C), then run check 1                                                                                                    | 502 with `{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The model provider is unavailable"}}`. No address in the body.            |
| 10  | Restart the provider and repeat check 1                                                                                                                     | Works again.                                                                                                                           |
| 11  | Start check 1 and press Ctrl+C in the `curl` window after a few frames                                                                                      | The provider's terminal shows no more output for that request, because the upstream request was aborted.                               |

### 4. Check the logs

In Terminal 2 there is one `request` line per call, with `http_method`, `status` and `duration_ms`. The prompt, the answer and the keys do not appear.

### 5. Known misses to try (expected to leak, see ADR 025)

- `Email john at example dot com` → returned unchanged.
- `SSN 123456789` (no dashes) → returned unchanged.
- `Card 4111  1111 1111 1111` (two spaces) → returned unchanged.

### 6. What the automated tests cover that a manual run cannot

- Every split point of the input (`npm run test:task3`).
- The 10 MB bounded-holdback and the 250 ms ReDoS bound.
- Backpressure with a slow reader.
