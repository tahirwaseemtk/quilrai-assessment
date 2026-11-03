const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

// The form under which two keys are considered the same. Some parsers match keys loosely: Go's
// encoding/json matches struct fields case-insensitively (and folds U+017F to "s", U+212A to
// "k"), and normalizing parsers equate compatibility forms such as fullwidth letters.
// NFKC, then upper- and lower-casing, covers all of these.
export function foldForComparison(value: string): string {
  return value.normalize('NFKC').toUpperCase().toLowerCase();
}

// True when any object in `text` repeats a key, compared after decoding escapes and folding
// (see foldForComparison). Parsers disagree on which duplicate wins, so a duplicated key could
// make a proxy and the server behind it read different requests. One linear pass over text that
// JSON.parse already accepted; an unterminated string is reported as unsafe rather than looping.
export function hasDuplicateKeys(text: string): boolean {
  const scopes: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === OPEN_OBJECT) scopes.push(new Set());
    else if (code === OPEN_ARRAY) scopes.push(null);
    else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) scopes.pop();
    else if (code === QUOTE) {
      const start = i;
      i += 1;
      while (i < text.length && text.charCodeAt(i) !== QUOTE) {
        i += text.charCodeAt(i) === BACKSLASH ? 2 : 1;
      }
      if (i >= text.length) return true;
      const end = i + 1;
      let next = end;
      while (JSON_WHITESPACE.has(text.charCodeAt(next))) next += 1;
      const keys = scopes.at(-1);
      if (keys && text.charCodeAt(next) === COLON) {
        let raw: string;
        try {
          raw = JSON.parse(text.slice(start, end)) as string;
        } catch {
          return true;
        }
        const key = foldForComparison(raw);
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
    i += 1;
  }
  return false;
}
