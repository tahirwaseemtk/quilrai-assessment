import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { foldForComparison, hasDuplicateKeys } from '../../shared/json-duplicate-keys.js';
import {
  argumentsHaveOwnProto,
  isPlainObject,
  readEnvelope,
  stripByteOrderMark,
  type RequestId,
} from '../../shared/jsonrpc-envelope.js';
import { RpcCode, rpcError, type RpcCodeValue, type RpcErrorResponse } from './rpc-errors.js';

// `message` is always the raw parsed body. Bodies are forwarded byte-for-byte (with the one accepted
// leading BOM stripped), which is safe because anything a downstream parser could read differently
// (duplicate or case-folded keys, tools/call lookalikes) is refused here. Precondition for the HTTP
// layer: decode the body as strict UTF-8 (invalid bytes are a parse error), so the text classified
// here is the text the downstream reads.
// A tools/call request is its own kind with a required toolName, so the admin gate cannot be
// skipped by a switch that forgets to look for it.
export type ClassifiedBody =
  | { kind: 'tool-call'; message: Record<string, unknown>; id: RequestId; toolName: string }
  | { kind: 'request'; message: Record<string, unknown>; id: RequestId; method: string }
  | { kind: 'notification'; message: Record<string, unknown>; method: string }
  | { kind: 'response'; message: Record<string, unknown> }
  | { kind: 'reply'; response: RpcErrorResponse }
  | { kind: 'drop' };

const TOOLS_CALL = 'tools/call';

// A method that only folds to tools/call ("Tools/Call", " tools/call") would be forwarded as an
// ordinary request, so a downstream that trims or lowercases methods would run it ungated.
function isToolsCallLookalike(method: string): boolean {
  return method !== TOOLS_CALL && foldForComparison(method.trim()) === TOOLS_CALL;
}

const reply = (id: RequestId | null, code: RpcCodeValue): ClassifiedBody => ({
  kind: 'reply',
  response: rpcError(id, code),
});

// The tool name is read from the raw own property, so an inherited "__proto__.name" can never
// stand in for it.
function toolNameOf(params: unknown): string | undefined {
  if (!isPlainObject(params) || !Object.hasOwn(params, 'name')) return undefined;
  const { name } = params;
  if (typeof name !== 'string') return undefined;
  if (Object.hasOwn(params, 'arguments') && !isPlainObject(params.arguments)) return undefined;
  if (argumentsHaveOwnProto(params)) return undefined;
  return name;
}

// Classifies a request body before anything is forwarded. The gateway answers malformed input
// itself: the downstream SDK would report a non-JSON-RPC body as -32700 instead of -32600.
export function classifyBody(body: string): ClassifiedBody {
  const envelope = readEnvelope(body);
  if (envelope.kind === 'parse-error') return reply(null, RpcCode.ParseError);

  // JSON.parse keeps the last of duplicated keys and other parsers keep the first, so a duplicate
  // ("method", "name", ...) could make the gateway approve one call and the downstream run
  // another. The ids themselves may be ambiguous, so the reply carries id null.
  if (hasDuplicateKeys(stripByteOrderMark(body))) return reply(null, RpcCode.InvalidRequest);

  switch (envelope.kind) {
    case 'invalid-request':
      return reply(envelope.id, RpcCode.InvalidRequest);
    case 'request': {
      const { value: message, id, method } = envelope;
      // The downstream SDK silently drops a message that fails its own schema (for example a
      // non-object _meta), which would leave the client waiting.
      if (!JSONRPCMessageSchema.safeParse(message).success) return reply(id, RpcCode.InvalidParams);
      if (isToolsCallLookalike(method)) return reply(id, RpcCode.InvalidRequest);
      if (method !== TOOLS_CALL) return { kind: 'request', message, id, method };
      const toolName = toolNameOf(message.params);
      if (toolName === undefined) return reply(id, RpcCode.InvalidParams);
      return { kind: 'tool-call', message, id, toolName };
    }
    case 'notification':
      // MCP has no tools/call notification, and without an id there is nowhere to send -32001,
      // so forwarding one would be an unanswerable path to a tool.
      if (envelope.method === TOOLS_CALL || isToolsCallLookalike(envelope.method)) {
        return { kind: 'drop' };
      }
      return JSONRPCMessageSchema.safeParse(envelope.value).success
        ? { kind: 'notification', message: envelope.value, method: envelope.method }
        : { kind: 'drop' };
    case 'response':
      return JSONRPCMessageSchema.safeParse(envelope.value).success
        ? { kind: 'response', message: envelope.value }
        : { kind: 'drop' };
    case 'invalid-notification':
    case 'invalid-response':
      return { kind: 'drop' };
  }
}
