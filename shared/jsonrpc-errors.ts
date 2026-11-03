// Standard JSON-RPC 2.0 error codes and their canonical messages, shared by every task.
export const JsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const JsonRpcMessage = {
  ParseError: 'Parse error',
  InvalidRequest: 'Invalid Request',
  MethodNotFound: 'Method not found',
  InvalidParams: 'Invalid params',
  InternalError: 'Internal error',
} as const;
