import { describe, expect, it } from 'vitest';
import {
  AMOUNT_MAX,
  GetCustomerRecordArgs,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  TriggerRefundArgs,
} from '../src/schemas.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../src/tool-schemas.js';
import { amountCases, reasonCases } from './helpers/schema-cases.js';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const CUSTOMER_ID_PATTERN = '^CUST-[0-9]{5}$';

interface PropertySchema {
  type: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  exclusiveMinimum?: number;
  maximum?: number;
}

// Evaluates the JSON Schema keywords these tools use, as a client-side validator would.
function satisfies(schema: PropertySchema, value: unknown): boolean {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    return schema.pattern === undefined || new RegExp(schema.pattern).test(value);
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    return schema.maximum === undefined || value <= schema.maximum;
  }
  return false;
}

const customerIdCases = [
  'CUST-00000',
  'CUST-99999',
  'CUST-1234',
  'CUST-123456',
  'cust-12345',
  'CUST12345',
  'CUST-1234a',
  '',
  ' CUST-12345',
  'CUST-12345\n',
  `CUST-${char(0xff11)}2345`,
  `CUST-${char(0x661)}2345`,
  `${char(0x421)}UST-12345`,
  `CUST-${char(0x200b)}12345`,
];

const refund = { customer_id: 'CUST-12345', amount: 19.99, reason: 'Duplicate charge' };

describe('get_customer_record inputSchema', () => {
  it('has the exact shape', () => {
    expect(getCustomerRecordInputSchema).toEqual({
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          pattern: CUSTOMER_ID_PATTERN,
          description: expect.any(String) as string,
        },
      },
      required: ['customer_id'],
      additionalProperties: false,
    });
  });

  it.each(customerIdCases)('pattern agrees with the Zod schema for %j', (id) => {
    expect(satisfies(getCustomerRecordInputSchema.properties.customer_id, id)).toBe(
      GetCustomerRecordArgs.safeParse({ customer_id: id }).success,
    );
  });
});

describe('trigger_refund inputSchema', () => {
  it('has the exact shape', () => {
    expect(triggerRefundInputSchema).toEqual({
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          pattern: CUSTOMER_ID_PATTERN,
          description: expect.any(String) as string,
        },
        amount: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: AMOUNT_MAX,
          description: expect.stringContaining('2 decimal places') as string,
        },
        reason: {
          type: 'string',
          minLength: REASON_MIN_LENGTH,
          maxLength: REASON_MAX_LENGTH,
          description: expect.stringContaining('visible') as string,
        },
      },
      required: ['customer_id', 'amount', 'reason'],
      additionalProperties: false,
    });
  });

  // The server may be stricter than the published schema (2 decimals, visible length), but
  // never looser: a client validating against inputSchema must not reject a valid call.
  it.each([...amountCases.valid, ...amountCases.invalid])(
    'every amount the server accepts passes the schema: %j',
    (amount) => {
      if (TriggerRefundArgs.safeParse({ ...refund, amount }).success) {
        expect(satisfies(triggerRefundInputSchema.properties.amount, amount)).toBe(true);
      }
    },
  );

  it.each([...reasonCases.valid, ...reasonCases.invalid])(
    'every reason the server accepts passes the schema: %j',
    (reason) => {
      if (TriggerRefundArgs.safeParse({ ...refund, reason }).success) {
        expect(satisfies(triggerRefundInputSchema.properties.reason, reason)).toBe(true);
      }
    },
  );

  it('rejects in the schema what the server rejects on bounds', () => {
    const { amount, reason } = triggerRefundInputSchema.properties;
    expect([0, -1, AMOUNT_MAX + 0.01].map((value) => satisfies(amount, value))).toEqual([
      false,
      false,
      false,
    ]);
    expect(satisfies(reason, 'a'.repeat(REASON_MAX_LENGTH + 1))).toBe(false);
    expect(satisfies(reason, 'a'.repeat(REASON_MIN_LENGTH - 1))).toBe(false);
  });
});

describe('exported schemas', () => {
  it.each([
    ['get_customer_record', getCustomerRecordInputSchema],
    ['trigger_refund', triggerRefundInputSchema],
  ])('%s round-trips through JSON without a $schema key', (_name, schema) => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(schema).not.toHaveProperty('$schema');
  });
});
