// ASCII only, so names that a lenient downstream might normalize into a gated name (fullwidth or
// Cyrillic letters, zero-width characters, trailing whitespace, percent-encoding) never reach the
// gate. A name is never trimmed or decoded: it is accepted exactly as sent, or refused.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}
