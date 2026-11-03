import { describe, expect, it } from 'vitest';
import { passesLuhn } from '../src/luhn.js';
import { MAX_HOLDBACK } from '../src/patterns.js';
import { createStreamingRedactor, redactText, REDACTED } from '../src/redactor.js';

const EMAIL = 'john.doe@example.com';
const SSN = '123-45-6789';
const CARD_SPACED = '4111 1111 1111 1111';
const CARD_DASHED = '4111-1111-1111-1111';
const CARD_PLAIN = '5555555555554444';

const SAMPLE = `Contact ${EMAIL} or call. SSN ${SSN}; card ${CARD_SPACED}, backup ${CARD_DASHED} and ${CARD_PLAIN}. Thanks!`;

const PII = [EMAIL, SSN, CARD_SPACED, CARD_DASHED, CARD_PLAIN];

// Feeds the text through the streaming redactor in the given pieces and returns the output.
function run(pieces: string[]): { output: string; peak: number } {
  const redactor = createStreamingRedactor();
  let output = '';
  for (const piece of pieces) output += redactor.push(piece);
  output += redactor.flush();
  return { output, peak: redactor.peakHeld };
}

// Small deterministic generator, so a failing split can be reproduced.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('luhn', () => {
  it.each(['4111111111111111', '5555555555554444', '378282246310005', '4222222222222'])(
    'accepts the valid number %s',
    (digits) => expect(passesLuhn(digits)).toBe(true),
  );

  it.each(['4111111111111112', '1234567890123', '0000000000000001'])(
    'rejects the invalid number %s',
    (digits) => expect(passesLuhn(digits)).toBe(false),
  );
});

describe('redactText', () => {
  it('redacts each kind of PII', () => {
    expect(redactText(`mail ${EMAIL}`)).toBe(`mail ${REDACTED}`);
    expect(redactText(`ssn ${SSN}`)).toBe(`ssn ${REDACTED}`);
    for (const card of [CARD_SPACED, CARD_DASHED, CARD_PLAIN]) {
      expect(redactText(`card ${card}`)).toBe(`card ${REDACTED}`);
    }
  });

  it.each([
    ['an SSN with an invalid area 000', '000-12-3456'],
    ['an SSN with an invalid area 666', '666-12-3456'],
    ['an SSN with an area in 900 to 999', '912-34-5678'],
    ['a nine-digit run with no dashes', '123456789'],
    ['a 12-digit number (too short for a card)', '411111111111'],
    ['a Luhn-invalid 16-digit number with no valid span', '4111 1111 1111 1113'],
  ])('leaves %s alone', (_label, text) => {
    expect(redactText(text)).toBe(text);
  });

  it('keeps the text around the matches', () => {
    expect(redactText(`(${EMAIL})`)).toBe(`(${REDACTED})`);
  });
});

describe('streaming redactor', () => {
  it('matches the whole-text result for the whole sample in one push', () => {
    expect(run([SAMPLE]).output).toBe(redactText(SAMPLE));
    expect(run([SAMPLE]).output).not.toMatch(/@|\d{3}-\d{2}-\d{4}|4111/);
  });

  it('emits identical output for every single split point (two pieces)', () => {
    const expected = redactText(SAMPLE);
    for (let cut = 0; cut <= SAMPLE.length; cut++) {
      const { output } = run([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]);
      expect(output, `split at ${cut}`).toBe(expected);
    }
  });

  it('emits identical output for seeded three-way splits', () => {
    const expected = redactText(SAMPLE);
    const random = seeded(42);
    for (let trial = 0; trial < 500; trial++) {
      const a = Math.floor(random() * (SAMPLE.length + 1));
      const b = Math.floor(random() * (SAMPLE.length + 1));
      const [first, second] = a < b ? [a, b] : [b, a];
      const { output } = run([
        SAMPLE.slice(0, first),
        SAMPLE.slice(first, second),
        SAMPLE.slice(second),
      ]);
      expect(output, `splits at ${first},${second}`).toBe(expected);
    }
  });

  it('never lets any PII through, at any split point', () => {
    for (let cut = 0; cut <= SAMPLE.length; cut++) {
      const { output } = run([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]);
      for (const secret of PII) expect(output).not.toContain(secret);
    }
  });

  it('emits ordinary prose at once, with nothing held back', () => {
    const redactor = createStreamingRedactor();
    expect(redactor.push('Hello there, ')).toBe('Hello there, ');
    expect(redactor.push('how are you today? ')).toBe('how are you today? ');
    expect(redactor.peakHeld).toBe(0);
  });

  it('holds only the trailing text that could still become PII', () => {
    const redactor = createStreamingRedactor();
    expect(redactor.push('reach john.do')).toBe('reach ');
    expect(redactor.push('e@exa')).toBe('');
    // "now" could still be the start of an address, so it waits for the next delimiter.
    expect(redactor.push('mple.com now')).toBe(`${REDACTED} `);
    expect(redactor.flush()).toBe('now');
  });

  it('keeps the holdback at or below MAX_HOLDBACK for a long unbroken run', () => {
    const redactor = createStreamingRedactor();
    for (let index = 0; index < 1000; index++) redactor.push('a'.repeat(50));
    expect(redactor.peakHeld).toBeLessThanOrEqual(MAX_HOLDBACK);
  });

  it('redacts held text on flush when the stream ends mid-number', () => {
    const redactor = createStreamingRedactor();
    expect(redactor.push('card 4111 1111 1111 1111')).toBe('card ');
    expect(redactor.flush()).toBe(REDACTED);
  });
});

describe('ReDoS safety', () => {
  it.each([
    ['a long digit-and-space run', '1 '.repeat(50_000)],
    ['a long local part with no @', 'a'.repeat(100_000)],
    ['a long dashed run', '1-'.repeat(50_000)],
    ['a 100 KB digit run', '1'.repeat(100_000)],
    ['a long dotted domain', `a@${'b.'.repeat(50_000)}`],
  ])(
    'handles %s within a 250 ms bound (timing only; redaction is asserted elsewhere)',
    (_label, text) => {
      const started = performance.now();
      run([text]);
      expect(performance.now() - started).toBeLessThan(250);
    },
  );
});

describe('regressions: runs, long domains', () => {
  const BACK_TO_BACK = 'Cards: 4111 1111 1111 1111 4111 1111 1111 1111 done';
  const ADJACENT = 'pay 4111111111111111 4242424242424242 today';
  const LONG_DOMAIN = `alice@${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.com`;

  it.each([
    ['back-to-back cards with spaces', BACK_TO_BACK],
    ['back-to-back cards with no separator', ADJACENT],
    ['a long domain', `mail ${LONG_DOMAIN} now`],
  ])('matches the whole-text result at every split point: %s', (_label, text) => {
    const expected = redactText(text);
    for (let cut = 0; cut <= text.length; cut++) {
      const { output } = run([text.slice(0, cut), text.slice(cut)]);
      expect(output, `split at ${cut}`).toBe(expected);
    }
  });

  it('streams a long domain one character at a time with nothing leaking', () => {
    const { output } = run(LONG_DOMAIN.split(''));
    expect(output).toBe(redactText(LONG_DOMAIN));
    expect(output).not.toContain('aaaa');
  });

  // Both cards are redacted. The separator between them may be absorbed into the redaction of
  // the first span, which is safe: the test asserts that no digits of either card survive.
  it('redacts both cards in back-to-back numbers', () => {
    for (const text of [BACK_TO_BACK, ADJACENT]) {
      const out = redactText(text);
      expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
      expect(out).not.toMatch(/4111|4242/);
    }
  });

  it('redacts a valid 16-digit card inside a 20-digit run (fails closed)', () => {
    expect(redactText('41111111111111111111')).not.toContain('4111111111111111');
  });
});

describe('regressions: cards next to extra digits, long local parts', () => {
  it.each([
    ['one extra digit', 'card 4111111111111111 1 end'],
    ['two extra digits', 'card 4111111111111111 12 end'],
    ['three extra digits', 'card 4111111111111111 123 end'],
    ['a short date after', '4111 1111 1111 1111 12/25'],
  ])('redacts the card with %s', (_label, text) => {
    expect(redactText(text)).toContain(REDACTED);
    expect(redactText(text)).not.toMatch(/4111 1111 1111 1111|4111111111111111/);
  });

  it('streams a card followed by extra digits with nothing leaking at any split', () => {
    const text = 'pay 4111111111111111 12 now';
    const expected = redactText(text);
    for (let cut = 0; cut <= text.length; cut++) {
      expect(run([text.slice(0, cut), text.slice(cut)]).output, `split ${cut}`).toBe(expected);
    }
  });

  it('does not match an overlong local part from the middle of it', () => {
    const text = `${'a'.repeat(100)}@x.com`;
    expect(redactText(text)).toBe(text);
  });
});
