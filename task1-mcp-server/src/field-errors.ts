import type { z } from 'zod';
import { ErrorMessage } from './errors.js';
import { AMOUNT_MAX, CUSTOMER_ID_DIGITS, REASON_MAX_LENGTH, REASON_MIN_LENGTH } from './schemas.js';

type Issue = z.ZodError['issues'][number];

// Field-level detail for -32602, composed as "Invalid params: <fragment>; <fragment>". A closed
// set of fixed strings: client input, including unknown key names, is never echoed back.
export const ArgumentMessage = {
  CustomerId: `customer_id must match CUST-${'X'.repeat(CUSTOMER_ID_DIGITS)} (${CUSTOMER_ID_DIGITS} digits)`,
  Amount: `amount must be a number greater than 0 and at most ${AMOUNT_MAX} with at most 2 decimal places`,
  Reason: `reason must be a string of at most ${REASON_MAX_LENGTH} characters with at least ${REASON_MIN_LENGTH} visible characters`,
  CustomerIdRequired: 'customer_id is required',
  AmountRequired: 'amount is required',
  ReasonRequired: 'reason is required',
  UnknownArguments: 'unknown arguments are not allowed',
  NotAnObject: 'arguments must be an object',
} as const;

const PREFIX = `${ErrorMessage.InvalidParams}: `;
const SEPARATOR = '; ';

// Each fragment belongs to one slot; a message may use each slot at most once, so a field can
// never be both "required" and "must ..." in the same reply.
const fragmentSlots = new Map<string, string>([
  [ArgumentMessage.CustomerId, 'customer_id'],
  [ArgumentMessage.CustomerIdRequired, 'customer_id'],
  [ArgumentMessage.Amount, 'amount'],
  [ArgumentMessage.AmountRequired, 'amount'],
  [ArgumentMessage.Reason, 'reason'],
  [ArgumentMessage.ReasonRequired, 'reason'],
  [ArgumentMessage.UnknownArguments, 'unknown'],
  [ArgumentMessage.NotAnObject, 'root'],
]);

// One entry per top-level argument, in the order fragments should appear.
export interface ArgumentField {
  name: string;
  invalid: string;
  required: string;
}

export function formatInvalidParams(fragments: readonly string[]): string {
  return PREFIX + fragments.join(SEPARATOR);
}

// Used by the outbound sanitizer. Linear in the message length: the fragment count is capped
// before any lookup, so a flood of fragments is rejected immediately.
export function isSafeArgumentMessage(message: string): boolean {
  if (!message.startsWith(PREFIX)) return false;
  const parts = message.slice(PREFIX.length).split(SEPARATOR);
  if (parts.length > fragmentSlots.size) return false;
  const slots = parts.map((part) => fragmentSlots.get(part));
  if (slots.some((slot) => slot === undefined)) return false;
  if (new Set(slots).size !== slots.length) return false;
  return !(slots.length > 1 && slots.includes('root'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Zod issues do not carry the input, so the raw arguments decide between "is required" and
// "must ...". Any issue that maps to no known field falls back to the plain message: a partial
// list would misdescribe the error. A tool that declares no fields always gets the plain message.
export function describeArgumentIssues(
  issues: readonly Issue[],
  args: unknown,
  fields: readonly ArgumentField[],
): string {
  if (fields.length === 0) return ErrorMessage.InvalidParams;
  if (!isPlainObject(args)) return formatInvalidParams([ArgumentMessage.NotAnObject]);

  const invalidFields = new Set<string>();
  let unknownKeys = false;
  for (const issue of issues) {
    const [key, ...rest] = issue.path;
    if (issue.code === 'unrecognized_keys' && key === undefined) {
      unknownKeys = true;
    } else if (
      typeof key === 'string' &&
      rest.length === 0 &&
      fields.some((field) => field.name === key)
    ) {
      invalidFields.add(key);
    } else {
      return ErrorMessage.InvalidParams;
    }
  }

  const present = (name: string): boolean => Object.hasOwn(args, name) && args[name] !== undefined;
  const fragments = fields
    .filter((field) => invalidFields.has(field.name))
    .map((field) => (present(field.name) ? field.invalid : field.required));
  if (unknownKeys) fragments.push(ArgumentMessage.UnknownArguments);
  return fragments.length > 0 ? formatInvalidParams(fragments) : ErrorMessage.InvalidParams;
}
