import {
  AMOUNT_MAX,
  CUSTOMER_ID_PATTERN,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
} from './schemas.js';

// Hand-written rather than generated with z.toJSONSchema: the generator cannot express the
// 2-decimal rule or code-point lengths, so these are kept in step with the Zod schemas by
// shared constants and parity tests. See ADR 014.
const customerIdProperty = {
  type: 'string',
  pattern: CUSTOMER_ID_PATTERN,
  description: 'Customer identifier in the form CUST-XXXXX, where X is a digit 0-9.',
};

export const getCustomerRecordInputSchema = {
  type: 'object' as const,
  properties: { customer_id: customerIdProperty },
  required: ['customer_id'],
  additionalProperties: false,
};

export const triggerRefundInputSchema = {
  type: 'object' as const,
  properties: {
    customer_id: customerIdProperty,
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: AMOUNT_MAX,
      description: `Refund amount: greater than 0, at most ${AMOUNT_MAX}, with at most 2 decimal places. Round to cents before sending; 0.1 + 0.2 (0.30000000000000004) is rejected.`,
    },
    reason: {
      type: 'string',
      minLength: REASON_MIN_LENGTH,
      maxLength: REASON_MAX_LENGTH,
      description: `Reason for the refund: at most ${REASON_MAX_LENGTH} characters, with at least ${REASON_MIN_LENGTH} visible characters. Surrounding whitespace and invisible formatting characters are trimmed and do not count.`,
    },
  },
  required: ['customer_id', 'amount', 'reason'],
  additionalProperties: false,
};
