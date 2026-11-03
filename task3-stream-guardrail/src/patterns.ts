// Every pattern uses bounded quantifiers and no nested repetition, so matching is linear in the
// input (ReDoS-safe). The lengths below are the longest text each pattern can match; the
// streaming holdback is derived from them, not hand-picked.

// local@domain. A domain is up to 11 labels of up to 63 characters, joined by dots.
export const EMAIL_LOCAL_MAX = 64;
export const EMAIL_LABEL_MAX = 63;
export const EMAIL_MAX_LABELS = 11;
export const EMAIL_DOMAIN_MAX = EMAIL_LABEL_MAX * EMAIL_MAX_LABELS + (EMAIL_MAX_LABELS - 1);
export const EMAIL_MAX_LENGTH = EMAIL_LOCAL_MAX + 1 + EMAIL_DOMAIN_MAX;

// 19 digits with a separator between each pair: 19 + 18 separators.
export const CARD_MIN_DIGITS = 13;
export const CARD_MAX_DIGITS = 19;
export const CARD_MAX_LENGTH = CARD_MAX_DIGITS * 2 - 1;

export const SSN_LENGTH = 11;

// The holdback never holds more than this. It is the longest text any pattern can match, so a
// match that is still incomplete at the end of a delta is always within it.
export const MAX_HOLDBACK = Math.max(EMAIL_MAX_LENGTH, CARD_MAX_LENGTH, SSN_LENGTH);

const LABEL = `[A-Za-z0-9-]{1,${EMAIL_LABEL_MAX}}`;
const DOMAIN = `${LABEL}(?:\\.${LABEL}){1,${EMAIL_MAX_LABELS - 1}}`;
const LOCAL = `[A-Za-z0-9._%+-]{1,${EMAIL_LOCAL_MAX}}`;

export const EMAIL = new RegExp(`(?<![A-Za-z0-9._%+-])${LOCAL}@${DOMAIN}`, 'g');

// A social security number in its ###-##-#### form. Area numbers 000, 666 and 900-999 are never
// issued, so they are not treated as SSNs.
export const SSN = /(?<![0-9-])(?!000|666|9\d\d)\d{3}-\d{2}-\d{4}(?![0-9-])/g;

// A whole run of digits, each pair optionally separated by one space or dash. The run is matched
// whole, because a card can sit inside a longer run; the redactor then checks each 13 to 19 digit
// span of it. The quantifier is unbounded only in the sense of a single linear pass: each step
// consumes one digit.
export const CARD_RUN = /[0-9](?:[ -]?[0-9])*/g;

export const CARD = new RegExp(
  `(?<![0-9])[0-9](?:[ -]?[0-9]){${CARD_MIN_DIGITS - 1},${CARD_MAX_DIGITS - 1}}(?![0-9])`,
  'g',
);

// Characters a match can contain. A trailing run of these is the only text that can still grow
// into a match, so the holdback is made of runs, not of guessed prefixes.
export const EMAIL_CHAR = /[A-Za-z0-9._%+@-]/;
export const CARD_CHAR = /[0-9 -]/;
export const DIGIT = /[0-9]/;
