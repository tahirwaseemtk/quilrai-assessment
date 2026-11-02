import { z } from 'zod';

// [0-9] rather than \d: some validators (Python re) treat \d as any Unicode digit.
export const CUSTOMER_ID_PATTERN = '^CUST-[0-9]{5}$';
export const AMOUNT_MAX = 10_000;
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;

// Zero-width, bidi and other format characters: invisible, so they never count as content.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const PADDING = /^[\s\p{Default_Ignorable_Code_Point}]$/u;

// True when the double is exactly the nearest 2-decimal value, e.g. 19.99 (stored as
// 19.989999...) passes while 1.005 and 1e-7 fail. Multiplying by 100 would misjudge both.
export function hasAtMostTwoDecimals(value: number): boolean {
  return Number(value.toFixed(2)) === value;
}

// Trims only the edges: invisible characters inside the text can be meaningful (emoji ZWJ
// sequences, ZWNJ in Persian and Indic scripts), so they are kept but not counted.
// A linear scan, because an end-anchored regex backtracks quadratically on long whitespace runs.
export function normalizeReason(value: string): string {
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && PADDING.test(chars[start] ?? '')) start += 1;
  while (end > start && PADDING.test(chars[end - 1] ?? '')) end -= 1;
  return chars.slice(start, end).join('');
}

// Code points, matching how JSON Schema minLength/maxLength count characters.
export function codePointLength(value: string): number {
  return [...value].length;
}

export function visibleLength(value: string): number {
  return codePointLength(value.replace(IGNORABLE, ''));
}

const customerId = z.string().regex(new RegExp(CUSTOMER_ID_PATTERN));

const amount = z
  .number()
  .positive()
  .max(AMOUNT_MAX)
  .refine(hasAtMostTwoDecimals, { message: 'amount must have at most 2 decimal places' });

// The maximum applies to the raw string so the published JSON Schema maxLength agrees with it;
// the minimum applies to visible content after trimming, which JSON Schema cannot express.
const reason = z
  .string()
  // abort: Zod otherwise keeps running later checks, normalizing an oversized string for nothing.
  .refine((value) => codePointLength(value) <= REASON_MAX_LENGTH, {
    message: `reason must be at most ${REASON_MAX_LENGTH} characters`,
    abort: true,
  })
  .overwrite(normalizeReason)
  .refine((value) => visibleLength(value) >= REASON_MIN_LENGTH, {
    message: `reason must have at least ${REASON_MIN_LENGTH} visible characters`,
  });

export const GetCustomerRecordArgs = z.strictObject({ customer_id: customerId });

export const TriggerRefundArgs = z.strictObject({
  customer_id: customerId,
  amount,
  reason,
});

export type GetCustomerRecordInput = z.infer<typeof GetCustomerRecordArgs>;
export type TriggerRefundInput = z.infer<typeof TriggerRefundArgs>;
