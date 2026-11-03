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
import { argumentsHaveOwnProto, readEnvelope } from '../../shared/jsonrpc-envelope.js';
import { ErrorCode, errorResponse } from './errors.js';

export type InboundResult =
  | { kind: 'message'; message: JSONRPCMessage }
  | { kind: 'reply'; response: JSONRPCErrorResponse }
  | { kind: 'drop' };

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

// The SDK (and Zod) rebuild `arguments` and silently drop an own __proto__ key, which JSON.parse
// creates, so the strict tool schemas would never report it as unknown. Checked on the raw object.
const noProtoArgumentKey: Validator = {
  safeParse: (value) => ({
    success: !argumentsHaveOwnProto((value as { params?: unknown }).params),
  }),
};

const methodValidators = new Map<string, readonly Validator[]>([
  ['initialize', [InitializeRequestSchema]],
  ['ping', [PingRequestSchema]],
  ['tools/list', [ListToolsRequestSchema]],
  [
    'tools/call',
    [CallToolRequestSchema, z.looseObject({ params: toolCallParamsSchema }), noProtoArgumentKey],
  ],
]);

// Anything passed on must also satisfy the SDK's own message schema: the SDK silently drops
// messages that fail it (for example a non-object params._meta), leaving a request unanswered.
function paramsValid(value: Record<string, unknown>): boolean {
  if (!JSONRPCMessageSchema.safeParse(value).success) return false;
  const validators = methodValidators.get(String(value.method)) ?? [];
  return validators.every((validator) => validator.safeParse(value).success);
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
  const envelope = readEnvelope(line);
  switch (envelope.kind) {
    case 'parse-error':
      return reply(null, ErrorCode.ParseError);
    case 'invalid-request':
      return reply(envelope.id, ErrorCode.InvalidRequest);
    case 'request':
      return paramsValid(envelope.value)
        ? message(envelope.value)
        : reply(envelope.id, ErrorCode.InvalidParams);
    case 'notification':
      return paramsValid(envelope.value) ? message(envelope.value) : drop;
    // Responses are never answered (JSON-RPC 2.0, section 5); invalid ones are dropped.
    case 'response':
      return JSONRPCMessageSchema.safeParse(envelope.value).success
        ? message(envelope.value)
        : drop;
    case 'invalid-notification':
    case 'invalid-response':
      return drop;
  }
}
