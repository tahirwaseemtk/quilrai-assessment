import {
  CARD_CHAR,
  CARD_MAX_DIGITS,
  CARD_MIN_DIGITS,
  CARD_RUN,
  DIGIT,
  EMAIL,
  EMAIL_CHAR,
  MAX_HOLDBACK,
  SSN,
} from './patterns.js';

export const REDACTED = '[REDACTED]';

// Redacts every complete match in a string. Used on text that is known to be whole, and on the
// text the streaming redactor decides it can emit.
export function redactText(text: string): string {
  return text.replace(EMAIL, REDACTED).replace(SSN, REDACTED).replace(CARD_RUN, redactCards);
}

// Replaces every 13 to 19 digit span of a digit run that passes Luhn. Spans are taken from the
// left, longest first, so a card followed by more digits is found whole and the rest is kept.
function redactCards(run: string): string {
  const positions: number[] = [];
  for (let index = 0; index < run.length; index++) {
    if (DIGIT.test(run.charAt(index))) positions.push(index);
  }
  const digits = positions.map((index) => run.charCodeAt(index) - 48);
  let out = '';
  let copied = 0;
  let next = 0;
  for (let first = 0; first < digits.length; first++) {
    if (first < next) continue;
    const last = longestLuhnSpan(digits, first);
    if (last === undefined) continue;
    out += run.slice(copied, positions[first]) + REDACTED;
    copied = (positions[last] ?? 0) + 1;
    next = last + 1;
  }
  return out + run.slice(copied);
}

// The last digit index of the longest 13 to 19 digit span starting at `first` that passes Luhn.
function longestLuhnSpan(digits: number[], first: number): number | undefined {
  const longest = Math.min(digits.length - 1, first + CARD_MAX_DIGITS - 1);
  for (let last = longest; last - first + 1 >= CARD_MIN_DIGITS; last--) {
    if (luhnValid(digits, first, last)) return last;
  }
  return undefined;
}

// Luhn over digits[first..last] without building strings: the same test as passesLuhn.
function luhnValid(digits: number[], first: number, last: number): boolean {
  let sum = 0;
  let double = false;
  for (let index = last; index >= first; index--) {
    let value = digits[index] ?? 0;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

// Start of the trailing run of characters that satisfy `inRun`, looking back no further than
// `floor`. A run is the whole suffix, so back-to-back numbers stay in one run.
function runStart(buffer: string, inRun: RegExp, floor: number): number {
  let start = buffer.length;
  while (start > floor && inRun.test(buffer.charAt(start - 1))) start--;
  return start;
}

// Where the held text starts: the earliest point that could still become part of a match. An
// email or a card can only be incomplete if it is inside the trailing run of its characters.
// Runs are held whole, because a card can continue after a space ("4111 1111 ... 4111") and two
// cards separated by one space are one run.
function holdbackStart(buffer: string): number {
  const floor = Math.max(0, buffer.length - MAX_HOLDBACK);
  const email = runStart(buffer, EMAIL_CHAR, floor);
  // A card never begins with a separator, so the start is moved forward to the first digit.
  let card = runStart(buffer, CARD_CHAR, floor);
  while (card < buffer.length && !DIGIT.test(buffer.charAt(card))) card++;
  return Math.min(email, card);
}

export interface StreamingRedactor {
  // Returns the text that is safe to emit now. The rest is held until more text arrives.
  push(text: string): string;
  // Ends the stream: everything still held is redacted and returned.
  flush(): string;
  // The largest number of characters held at any moment (for tests and metrics).
  readonly peakHeld: number;
}

// Prefix-aware holdback: only the trailing text that could still become a match is held. Ordinary
// prose ends in a space or punctuation, so it passes through with no delay.
export function createStreamingRedactor(): StreamingRedactor {
  let held = '';
  let peak = 0;
  return {
    push(text) {
      const buffer = held + text;
      const cut = holdbackStart(buffer);
      held = buffer.slice(cut);
      peak = Math.max(peak, held.length);
      return redactText(buffer.slice(0, cut));
    },
    flush() {
      const rest = held;
      held = '';
      return redactText(rest);
    },
    get peakHeld() {
      return peak;
    },
  };
}
