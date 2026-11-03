import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, canonicalMessage, isKnownCode, isSafeMessage } from './errors.js';
import { isSafeArgumentMessage } from './field-errors.js';

const SDK_PREFIX = /^MCP error -?\d+: /;

// Last line of defence: only allowlisted, per-code messages reach the client, whatever the
// SDK or a handler produced.
export function sanitizeOutbound(message: JSONRPCMessage): JSONRPCMessage {
  if (!('error' in message)) return message;

  const { code, message: text } = message.error;
  const safeCode = isKnownCode(code) ? code : ErrorCode.InternalError;
  const stripped = text.replace(SDK_PREFIX, '');
  const allowed =
    isSafeMessage(code, stripped) ||
    (code === ErrorCode.InvalidParams && isSafeArgumentMessage(stripped));
  const safeText = safeCode === code && allowed ? stripped : canonicalMessage(safeCode);

  const error = { code: safeCode, message: safeText };
  return 'id' in message
    ? { jsonrpc: message.jsonrpc, id: message.id, error }
    : { jsonrpc: message.jsonrpc, error };
}
