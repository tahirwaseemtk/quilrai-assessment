import type { JSONRPCErrorResponse, RequestId } from '@modelcontextprotocol/sdk/types.js';

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const ErrorMessage = {
  ParseError: 'Parse error',
  InvalidRequest: 'Invalid Request',
  MethodNotFound: 'Method not found',
  InvalidParams: 'Invalid params',
  InternalError: 'Internal error',
  UnknownTool: 'Unknown tool',
} as const;

const canonical = new Map<number, string>([
  [ErrorCode.ParseError, ErrorMessage.ParseError],
  [ErrorCode.InvalidRequest, ErrorMessage.InvalidRequest],
  [ErrorCode.MethodNotFound, ErrorMessage.MethodNotFound],
  [ErrorCode.InvalidParams, ErrorMessage.InvalidParams],
  [ErrorCode.InternalError, ErrorMessage.InternalError],
]);

// Messages allowed on the wire besides each code's canonical message.
const extraSafeMessages = new Map<number, readonly string[]>([
  [ErrorCode.InvalidParams, [ErrorMessage.UnknownTool]],
]);

const safeMessages = new Map<number, ReadonlySet<string>>(
  [...canonical].map(([code, message]) => [
    code,
    new Set([message, ...(extraSafeMessages.get(code) ?? [])]),
  ]),
);

// Thrown from request handlers. The SDK copies a numeric `code` and `message` verbatim to the
// wire; McpError would prefix the message with "MCP error <code>: ".
export class RpcError extends Error {
  override readonly name = 'RpcError';

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function isKnownCode(code: number): boolean {
  return canonical.has(code);
}

export function canonicalMessage(code: number): string {
  return canonical.get(code) ?? ErrorMessage.InternalError;
}

export function isSafeMessage(code: number, message: string): boolean {
  return safeMessages.get(code)?.has(message) ?? false;
}

export function errorResponse(
  id: RequestId | null,
  code: number,
  message: string = canonicalMessage(code),
): JSONRPCErrorResponse {
  // JSON-RPC requires `id: null` when the request id cannot be determined; the SDK type omits it.
  return { jsonrpc: '2.0', id, error: { code, message } } as JSONRPCErrorResponse;
}
