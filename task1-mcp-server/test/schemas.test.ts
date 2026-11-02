import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AMOUNT_MAX,
  normalizeReason,
  GetCustomerRecordArgs,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  TriggerRefundArgs,
} from '../src/schemas.js';
import { amountCases, reasonCases } from './helpers/schema-cases.js';

type Path = (string | number)[];

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const ZWSP = char(0x200b);
const ZWNJ = char(0x200c);
const ZWJ = char(0x200d);
const WORD_JOINER = char(0x2060);
const BOM = char(0xfeff);

function expectFailAt(schema: z.ZodType, input: unknown, path: Path): void {
  const result = schema.safeParse(input);
  expect(result.success, JSON.stringify(input)).toBe(false);
  const paths = result.error?.issues.map((issue) => issue.path) ?? [];
  expect(paths.length).toBeGreaterThan(0);
  for (const issuePath of paths) expect(issuePath).toEqual(path);
}

const refund = { customer_id: 'CUST-12345', amount: 19.99, reason: 'Duplicate charge' };
const withAmount = (amount: unknown) => ({ ...refund, amount });
const withReason = (reason: unknown) => ({ ...refund, reason });

describe('shared limits', () => {
  it('uses the agreed bounds', () => {
    expect(AMOUNT_MAX).toBe(10_000);
    expect(REASON_MIN_LENGTH).toBe(10);
    expect(REASON_MAX_LENGTH).toBe(500);
  });
});

describe('customer_id', () => {
  it.each(['CUST-00000', 'CUST-99999', 'CUST-12345'])('accepts %s', (id) => {
    expect(GetCustomerRecordArgs.parse({ customer_id: id })).toEqual({ customer_id: id });
  });

  it.each([
    'CUST-1234',
    'CUST-123456',
    'cust-12345',
    'CUST12345',
    'CUST-1234a',
    'CUST--12345',
    'XCUST-12345',
    '',
    ' CUST-12345',
    'CUST-12345 ',
    'CUST-12345\n',
    '\nCUST-12345',
    `CUST-${char(0xff11)}${char(0xff12)}${char(0xff13)}${char(0xff14)}${char(0xff15)}`,
    `CUST-${char(0x661)}${char(0x662)}${char(0x663)}${char(0x664)}${char(0x665)}`,
    `${char(0x421)}UST-12345`,
    `CUST${char(0x2013)}12345`,
    `CUST-${ZWSP}12345`,
  ])('rejects %j', (id) => {
    expectFailAt(GetCustomerRecordArgs, { customer_id: id }, ['customer_id']);
  });

  it.each([12345, null, true, ['CUST-12345'], {}])('rejects non-string %j', (id) => {
    expectFailAt(GetCustomerRecordArgs, { customer_id: id }, ['customer_id']);
  });

  it('rejects a missing customer_id', () => {
    expectFailAt(GetCustomerRecordArgs, {}, ['customer_id']);
  });
});

describe('arguments object', () => {
  it.each([undefined, null, [], 'CUST-12345', 42])('rejects %j at the root', (input) => {
    expectFailAt(GetCustomerRecordArgs, input, []);
    expectFailAt(TriggerRefundArgs, input, []);
  });

  it('rejects unknown keys', () => {
    const result = GetCustomerRecordArgs.safeParse({ customer_id: 'CUST-12345', extra: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['extra'] });
  });

  it.each(['__proto__', 'constructor'])(
    'rejects an own %s key without polluting Object.prototype',
    (key) => {
      const input: unknown = JSON.parse(`{"customer_id":"CUST-12345","${key}":{"polluted":1}}`);
      const result = GetCustomerRecordArgs.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: [key] });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
});

describe('amount', () => {
  it.each(amountCases.valid)('accepts %d', (amount) => {
    expect(TriggerRefundArgs.parse(withAmount(amount)).amount).toBe(amount);
  });

  it.each(amountCases.invalid)('rejects %j', (amount) => {
    expectFailAt(TriggerRefundArgs, withAmount(amount), ['amount']);
  });

  it('rejects float arithmetic that is not exactly 2 decimals', () => {
    expectFailAt(TriggerRefundArgs, withAmount(0.1 + 0.2), ['amount']);
    expect(TriggerRefundArgs.parse(withAmount(Number((0.1 + 0.2).toFixed(2)))).amount).toBe(0.3);
  });
});

describe('reason', () => {
  it.each(reasonCases.valid)('accepts %j', (reason) => {
    expect(TriggerRefundArgs.safeParse(withReason(reason)).success).toBe(true);
  });

  it.each(reasonCases.invalid)('rejects %j', (reason) => {
    expectFailAt(TriggerRefundArgs, withReason(reason), ['reason']);
  });

  it('trims surrounding whitespace and invisible characters before storing', () => {
    expect(TriggerRefundArgs.parse(withReason(`  ${BOM}0123456789${ZWSP}  `)).reason).toBe(
      '0123456789',
    );
  });

  it('keeps inner whitespace', () => {
    expect(TriggerRefundArgs.parse(withReason('  a   b   c   d  ')).reason).toBe('a   b   c   d');
  });

  it('keeps inner invisible characters but does not count them', () => {
    const inner = `0123${ZWSP}45${WORD_JOINER}678${BOM}9`;
    expect(TriggerRefundArgs.parse(withReason(inner)).reason).toBe(inner);
    expectFailAt(TriggerRefundArgs, withReason(`012${ZWSP}${ZWSP}3456${WORD_JOINER}78`), [
      'reason',
    ]);
  });

  it('preserves emoji ZWJ sequences and ZWNJ in Persian text', () => {
    const family = `Family plan ${char(0x1f468)}${ZWJ}${char(0x1f469)}${ZWJ}${char(0x1f467)} billed twice`;
    const persian = `${char(0x645)}${char(0x6cc)}${ZWNJ}${char(0x62e)}${char(0x648)}${char(0x627)}${char(0x647)}${char(0x645)} refund`;
    expect(TriggerRefundArgs.parse(withReason(family)).reason).toBe(family);
    expect(TriggerRefundArgs.parse(withReason(persian)).reason).toBe(persian);
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = char(0x1f600);
    expect(TriggerRefundArgs.parse(withReason(emoji.repeat(10))).reason).toBe(emoji.repeat(10));
    expectFailAt(TriggerRefundArgs, withReason(emoji.repeat(9)), ['reason']);
  });

  it('applies the maximum to the raw string, padding included', () => {
    expect(TriggerRefundArgs.safeParse(withReason(`${'a'.repeat(499)}${ZWSP}`)).success).toBe(true);
    expectFailAt(TriggerRefundArgs, withReason(`  ${'a'.repeat(500)}  `), ['reason']);
  });

  // A 1 MiB transport line could otherwise carry input that makes trimming quadratic.
  it('handles near-1 MiB padded input in linear time', () => {
    const padded = `a${' '.repeat(1_000_000)}a`;
    let start = performance.now();
    expectFailAt(TriggerRefundArgs, withReason(padded), ['reason']);
    expect(performance.now() - start).toBeLessThan(500);

    start = performance.now();
    expect(normalizeReason(`${' '.repeat(500_000)}a${' '.repeat(500_000)}`)).toBe('a');
    expect(normalizeReason(`a${' '.repeat(1_000_000)}b`)).toBe(`a${' '.repeat(1_000_000)}b`);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it.each([1234567890, null, ['0123456789']])('rejects non-string %j', (reason) => {
    expectFailAt(TriggerRefundArgs, withReason(reason), ['reason']);
  });
});

describe('trigger_refund object', () => {
  it('accepts the baseline', () => {
    expect(TriggerRefundArgs.parse(refund)).toEqual(refund);
  });

  it.each(['customer_id', 'amount', 'reason'] as const)('rejects a missing %s', (key) => {
    const input: Record<string, unknown> = { ...refund };
    delete input[key];
    expectFailAt(TriggerRefundArgs, input, [key]);
  });

  it.each([{ currency: 'USD' }, { customerId: 'CUST-12345' }])('rejects extra key %j', (extra) => {
    const result = TriggerRefundArgs.safeParse({ ...refund, ...extra });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: Object.keys(extra),
    });
  });

  it('reports every invalid field', () => {
    const result = TriggerRefundArgs.safeParse({ customer_id: 'bad', amount: -1, reason: 'short' });
    expect(result.success).toBe(false);
    const paths = new Set(result.error?.issues.map((issue) => issue.path.join('.')));
    expect(paths).toEqual(new Set(['customer_id', 'amount', 'reason']));
  });
});
