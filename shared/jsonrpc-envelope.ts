import { z } from 'zod';

// Strict JSON-RPC 2.0 envelopes as MCP uses them: ids are strings or safe integers (z.int() is
// bounded to safe integers), params must be an object, unknown top-level keys are rejected, and
// a response result must be an object.
export type RequestId = string | number;

export const idSchema = z.union([z.string(), z.int()]);
const paramsSchema = z.looseObject({});

export const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema,
  method: z.string(),
  params: paramsSchema.optional(),
});

export const notificationSchema = requestSchema.omit({ id: true });

export const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: idSchema, result: z.looseObject({}) }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: idSchema,
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
  }),
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BYTE_ORDER_MARK = 0xfeff;

// Only one leading byte order mark is removed; JSON.parse handles real JSON whitespace. trim()
// would also accept NBSP, U+2028 and other characters a downstream JSON parser rejects.
export function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
}

// An own "__proto__" key in tools/call arguments: JSON.parse creates it, but SDKs and Zod copies
// drop it silently, so strict argument schemas never see it. Callers treat it as invalid params.
export function argumentsHaveOwnProto(params: unknown): boolean {
  if (!isPlainObject(params)) return false;
  const args = params.arguments;
  return isPlainObject(args) && Object.hasOwn(args, '__proto__');
}

// `value` is always the raw parsed object, never a Zod copy: Zod copies drop an own "__proto__"
// key, and callers forward or inspect exactly what the client sent.
export type Envelope =
  | { kind: 'parse-error' }
  | { kind: 'invalid-request'; id: RequestId | null }
  | { kind: 'request'; value: Record<string, unknown>; id: RequestId; method: string }
  | { kind: 'notification'; value: Record<string, unknown>; method: string }
  | { kind: 'response'; value: Record<string, unknown> }
  | { kind: 'invalid-notification' }
  | { kind: 'invalid-response' };

// The generic decision tree. Callers turn parse-error / invalid-request into replies and, as
// JSON-RPC requires, never reply to an invalid notification or response.
export function readEnvelope(text: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(stripByteOrderMark(text));
  } catch {
    return { kind: 'parse-error' };
  }

  // Arrays land here too: batches are not supported.
  if (!isPlainObject(value)) return { kind: 'invalid-request', id: null };

  const idResult = idSchema.safeParse(value.id);
  const id = idResult.success ? idResult.data : null;
  const has = (key: string): boolean => Object.hasOwn(value, key);

  if (has('method')) {
    // A notification is an object with no "id" key and a string method; anything else carrying a
    // method is a request, so even {"id":null,...} or a non-string method gets a reply.
    if (!has('id') && typeof value.method === 'string') {
      return notificationSchema.safeParse(value).success
        ? { kind: 'notification', value, method: value.method }
        : { kind: 'invalid-notification' };
    }
    const request = requestSchema.safeParse(value);
    if (!request.success) return { kind: 'invalid-request', id };
    return { kind: 'request', value, id: request.data.id, method: request.data.method };
  }

  if (has('result') || has('error')) {
    return responseSchema.safeParse(value).success
      ? { kind: 'response', value }
      : { kind: 'invalid-response' };
  }

  return { kind: 'invalid-request', id };
}
