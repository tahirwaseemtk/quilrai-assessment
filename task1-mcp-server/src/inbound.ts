import { z } from 'zod';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, errorResponse } from './errors.js';

export type InboundResult =
  | { kind: 'message'; message: JSONRPCMessage }
  | { kind: 'reply'; response: JSONRPCErrorResponse }
  | { kind: 'drop' };

// MCP request ids are strings or safe integers (z.int() is bounded to safe integers).
const idSchema = z.union([z.string(), z.int()]);
const paramsSchema = z.looseObject({});

const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema,
  method: z.string(),
  params: paramsSchema.optional(),
});

const notificationSchema = requestSchema.omit({ id: true });

const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: idSchema, result: z.looseObject({}) }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: idSchema,
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
  }),
]);

// The SDK validates these methods' params itself, but a failure surfaces as -32603 (or -32602
// with Zod issue text for tools/call). Checking first lets us answer a clean -32602.
interface Validator {
  safeParse(value: unknown): { success: boolean };
}

const toolCallParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.looseObject({}).optional(),
  // Task-augmented calls need a capability this server does not declare.
  task: z.never().optional(),
});

const methodValidators = new Map<string, readonly Validator[]>([
  ['initialize', [InitializeRequestSchema]],
  ['ping', [PingRequestSchema]],
  ['tools/list', [ListToolsRequestSchema]],
  ['tools/call', [CallToolRequestSchema, z.looseObject({ params: toolCallParamsSchema })]],
]);

// Anything passed on must also satisfy the SDK's own message schema: the SDK silently drops
// messages that fail it (for example a non-object params._meta), leaving a request unanswered.
function paramsValid(value: Record<string, unknown>): boolean {
  if (!JSONRPCMessageSchema.safeParse(value).success) return false;
  const validators = methodValidators.get(String(value.method)) ?? [];
  return validators.every((validator) => validator.safeParse(value).success);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const message = (value: Record<string, unknown>): InboundResult => ({
  kind: 'message',
  message: value as JSONRPCMessage,
});

const reply = (id: string | number | null, code: number): InboundResult => ({
  kind: 'reply',
  response: errorResponse(id, code),
});

const drop: InboundResult = { kind: 'drop' };

export function classifyInbound(line: string): InboundResult {
  let value: unknown;
  try {
    // trim() also removes a leading byte order mark.
    value = JSON.parse(line.trim());
  } catch {
    return reply(null, ErrorCode.ParseError);
  }

  if (!isPlainObject(value)) return reply(null, ErrorCode.InvalidRequest);

  const idResult = idSchema.safeParse(value.id);
  const id = idResult.success ? idResult.data : null;
  const has = (key: string): boolean => Object.hasOwn(value, key);

  if (has('method')) {
    const isNotification = !has('id') && typeof value.method === 'string';
    if (isNotification) {
      const valid = notificationSchema.safeParse(value).success && paramsValid(value);
      return valid ? message(value) : drop;
    }
    if (!requestSchema.safeParse(value).success) return reply(id, ErrorCode.InvalidRequest);
    if (!paramsValid(value)) return reply(id, ErrorCode.InvalidParams);
    return message(value);
  }

  // Responses are never answered (JSON-RPC 2.0, section 5); invalid ones are dropped.
  if (has('result') || has('error')) {
    const valid =
      responseSchema.safeParse(value).success && JSONRPCMessageSchema.safeParse(value).success;
    return valid ? message(value) : drop;
  }

  return reply(id, ErrorCode.InvalidRequest);
}
