import type { RequestId } from '../../shared/jsonrpc-envelope.js';
import { JsonRpcCode, JsonRpcMessage } from '../../shared/jsonrpc-errors.js';

export const RpcCode = { ...JsonRpcCode, UnauthorizedToolCall: -32001 } as const;

export type RpcCodeValue = (typeof RpcCode)[keyof typeof RpcCode];

// Keyed by code, so adding a code without a message fails to compile.
const messages: Readonly<Record<RpcCodeValue, string>> = {
  [RpcCode.ParseError]: JsonRpcMessage.ParseError,
  [RpcCode.InvalidRequest]: JsonRpcMessage.InvalidRequest,
  [RpcCode.MethodNotFound]: JsonRpcMessage.MethodNotFound,
  [RpcCode.InvalidParams]: JsonRpcMessage.InvalidParams,
  [RpcCode.InternalError]: JsonRpcMessage.InternalError,
  [RpcCode.UnauthorizedToolCall]: 'Unauthorized Tool Call',
};

export interface RpcErrorResponse {
  jsonrpc: '2.0';
  id: RequestId | null;
  error: { code: number; message: string };
}

// Errors the gateway answers itself carry only fixed messages: nothing from the request or from
// the downstream is ever echoed. A code outside the set (only reachable through a cast) becomes
// Internal error.
export function rpcError(id: RequestId | null, code: RpcCodeValue): RpcErrorResponse {
  const message = Object.hasOwn(messages, code) ? messages[code] : undefined;
  if (message === undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: RpcCode.InternalError, message: JsonRpcMessage.InternalError },
    };
  }
  return { jsonrpc: '2.0', id, error: { code, message } };
}
