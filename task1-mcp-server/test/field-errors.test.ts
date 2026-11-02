import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ArgumentMessage,
  describeArgumentIssues,
  isSafeArgumentMessage,
  type ArgumentField,
} from '../src/field-errors.js';
import { sanitizeOutbound } from '../src/outbound.js';
import { GetCustomerRecordArgs, TriggerRefundArgs } from '../src/schemas.js';
import { customerRecordFields, refundFields } from '../src/tools.js';
import { amountCases, reasonCases } from './helpers/schema-cases.js';

const P = 'Invalid params: ';
const M = ArgumentMessage;
const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const refund = { customer_id: 'CUST-00001', amount: 50, reason: 'Damaged on arrival' };

type Issues = z.ZodError['issues'];

function describe_(schema: z.ZodType, fields: readonly ArgumentField[], args: unknown): string {
  const parsed = schema.safeParse(args);
  if (parsed.success) throw new Error(`expected ${JSON.stringify(args)} to be invalid`);
  return describeArgumentIssues(parsed.error.issues, args, fields);
}
const forRecord = (args: unknown) => describe_(GetCustomerRecordArgs, customerRecordFields, args);
const forRefund = (args: unknown) => describe_(TriggerRefundArgs, refundFields, args);
const message = (...fragments: string[]) => P + fragments.join('; ');

const generated: string[] = [];
const track = (value: string): string => {
  generated.push(value);
  return value;
};

describe('argument fragments', () => {
  it('are the fixed, agreed strings', () => {
    expect(ArgumentMessage).toEqual({
      CustomerId: 'customer_id must match CUST-XXXXX (5 digits)',
      Amount:
        'amount must be a number greater than 0 and at most 10000 with at most 2 decimal places',
      Reason:
        'reason must be a string of at most 500 characters with at least 10 visible characters',
      CustomerIdRequired: 'customer_id is required',
      AmountRequired: 'amount is required',
      ReasonRequired: 'reason is required',
      UnknownArguments: 'unknown arguments are not allowed',
      NotAnObject: 'arguments must be an object',
    });
  });
});

describe('describeArgumentIssues', () => {
  it.each([
    'CUST-1',
    'cust-00001',
    'CUST-000001',
    '',
    ' CUST-00001',
    `CUST-0000${char(0x661)}`,
    `${char(0xff23)}UST-00001`,
    null,
    12345,
    true,
    [],
    {},
  ])('reports an invalid customer_id %j', (id) => {
    expect(track(forRecord({ customer_id: id }))).toBe(message(M.CustomerId));
  });

  it.each(amountCases.invalid)('reports an invalid amount %j exactly once', (amount) => {
    expect(track(forRefund({ ...refund, amount }))).toBe(message(M.Amount));
  });

  it.each([-0.001, 10_000.001])('deduplicates the two issues for amount %d', (amount) => {
    expect(forRefund({ ...refund, amount })).toBe(message(M.Amount));
  });

  it.each([...reasonCases.invalid, 5, null, []])('reports an invalid reason %j', (reason) => {
    expect(track(forRefund({ ...refund, reason }))).toBe(message(M.Reason));
  });

  it.each([
    ['customer_id', M.CustomerIdRequired],
    ['amount', M.AmountRequired],
    ['reason', M.ReasonRequired],
  ] as const)('reports a missing %s as required', (key, fragment) => {
    const args: Record<string, unknown> = { ...refund };
    delete args[key];
    expect(track(forRefund(args))).toBe(message(fragment));
  });

  it('reports every missing field in schema order', () => {
    expect(track(forRecord({}))).toBe(message(M.CustomerIdRequired));
    expect(track(forRefund({}))).toBe(
      message(M.CustomerIdRequired, M.AmountRequired, M.ReasonRequired),
    );
  });

  it('orders fragments by the schema, not the input', () => {
    expect(track(forRefund({ reason: 'x', amount: 0, customer_id: 'bad' }))).toBe(
      message(M.CustomerId, M.Amount, M.Reason),
    );
  });

  it('mixes missing and invalid fields', () => {
    expect(track(forRefund({ amount: 0 }))).toBe(
      message(M.CustomerIdRequired, M.Amount, M.ReasonRequired),
    );
  });

  it.each([
    'extra',
    'Customer_ID',
    'customer_id ',
    'x; customer_id is required',
    '\n',
    'a'.repeat(10_000),
  ])('reports unknown key %j without echoing it', (key) => {
    const text = track(forRecord({ customer_id: 'CUST-00001', [key]: 1 }));
    expect(text).toBe(message(M.UnknownArguments));
  });

  it('never echoes prototype key names', () => {
    const args: unknown = JSON.parse(
      '{"customer_id":"CUST-00001","__proto__":{"p":1},"constructor":1,"toString":1,"hasOwnProperty":1}',
    );
    const text = forRecord(args);
    expect(text).toBe(message(M.UnknownArguments));
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });

  it('collapses many unknown keys into one fragment', () => {
    const args: Record<string, unknown> = { customer_id: 'CUST-00001' };
    for (let i = 0; i < 1000; i += 1) args[`k${i}`] = i;
    expect(forRecord(args)).toBe(message(M.UnknownArguments));
  });

  it('puts unknown keys after field fragments', () => {
    expect(track(forRecord({ customer_id: 'x', extra: 1 }))).toBe(
      message(M.CustomerId, M.UnknownArguments),
    );
    expect(track(forRefund({ customer_id: null, amount: null, reason: null, z: 1 }))).toBe(
      message(M.CustomerId, M.Amount, M.Reason, M.UnknownArguments),
    );
    expect(track(forRecord(JSON.parse('{"__proto__":1,"constructor":2}')))).toBe(
      message(M.CustomerIdRequired, M.UnknownArguments),
    );
  });

  it.each([null, [], 'CUST-00001', 0, true])('reports a non-object %j on its own', (args) => {
    expect(track(forRecord(args))).toBe(message(M.NotAnObject));
    expect(track(forRefund(args))).toBe(message(M.NotAnObject));
  });

  const issue = (path: (string | number)[]): Issues[number] => ({
    code: 'custom',
    path,
    message: 'x',
    input: undefined,
  });

  it.each([
    [['n']],
    [['constructor']],
    [['__proto__']],
    [['toString']],
    [[0]],
    [['customer_id', 'nested']],
  ])('falls back to plain Invalid params for an unmapped path %j', (path) => {
    expect(describeArgumentIssues([issue(path)], {}, customerRecordFields)).toBe('Invalid params');
  });

  it('falls back for the whole message when any issue is unmapped', () => {
    expect(
      describeArgumentIssues([issue(['customer_id']), issue(['n'])], {}, customerRecordFields),
    ).toBe('Invalid params');
  });

  it('falls back when there are no issues', () => {
    expect(describeArgumentIssues([], {}, customerRecordFields)).toBe('Invalid params');
  });

  it('only ever produces messages the outbound allowlist keeps', () => {
    expect(generated.length).toBeGreaterThan(30);
    for (const text of generated) {
      expect(isSafeArgumentMessage(text), text).toBe(true);
      expect(
        sanitizeOutbound({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: text } }),
      ).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: text } });
    }
  });
});

describe('describeArgumentIssues: opt-in and undefined values', () => {
  it('stays plain for a tool that declares no fields, even for unknown keys', () => {
    const unknownOnly = [
      { code: 'unrecognized_keys', keys: ['extra'], path: [], message: 'x', input: {} },
    ] as unknown as Issues;
    expect(describeArgumentIssues(unknownOnly, { extra: 1 }, [])).toBe('Invalid params');
  });

  it('treats a key set to undefined as missing', () => {
    expect(forRefund({ ...refund, amount: undefined })).toBe(message(M.AmountRequired));
  });
});

describe('isSafeArgumentMessage', () => {
  const cyrillicA = char(0x430);

  it.each([
    P + M.CustomerId,
    P + M.Amount,
    P + M.Reason,
    P + M.CustomerIdRequired,
    P + M.AmountRequired,
    P + M.ReasonRequired,
    P + M.UnknownArguments,
    P + M.NotAnObject,
    message(M.CustomerIdRequired, M.AmountRequired, M.ReasonRequired),
    message(M.CustomerId, M.Amount, M.Reason, M.UnknownArguments),
    message(M.Reason, M.CustomerId),
  ])('accepts %j', (text) => {
    expect(isSafeArgumentMessage(text)).toBe(true);
  });

  it.each([
    'Invalid params',
    'Invalid params:',
    P,
    `${P};`,
    `${P}${M.CustomerId}; `,
    `${P}${M.CustomerId};${M.Amount}`,
    `${P}${M.CustomerId};  ${M.Amount}`,
    `${P}${M.CustomerId}\n${M.Amount}`,
    message(M.CustomerId, M.CustomerId),
    message(M.CustomerId, M.CustomerIdRequired),
    message(M.AmountRequired, M.Amount),
    `${P}${M.CustomerId} extra`,
    `${P}customer_id must match CUST-XXXXX`,
    `${P}Unknown tool`,
    `${P}Invalid params`,
    `invalid params: ${M.CustomerId}`,
    ` ${P}${M.CustomerId}`,
    `Invalid params:${M.CustomerId}`,
    `${P}${M.CustomerId.replace('a', cyrillicA)}`,
    `${P}x`,
    `${P}secret /etc/passwd at f (C:\a.ts:1:1)`,
    `${P}${M.UnknownArguments}${M.UnknownArguments}`,
    message(M.NotAnObject, M.CustomerId),
    message(...Array<string>(20_000).fill(M.Amount)),
  ])('rejects %j', (text) => {
    expect(isSafeArgumentMessage(text)).toBe(false);
  });

  it.each([-32600, -32601, -32603, -32700])('is not accepted under code %i', (code) => {
    expect(
      sanitizeOutbound({ jsonrpc: '2.0', id: 1, error: { code, message: P + M.CustomerId } }),
    ).not.toMatchObject({ error: { message: P + M.CustomerId } });
  });
});

describe('allowlist coverage', () => {
  it('has a slot for every argument fragment', () => {
    for (const fragment of Object.values(ArgumentMessage)) {
      expect(isSafeArgumentMessage(P + fragment), fragment).toBe(true);
    }
  });
});
