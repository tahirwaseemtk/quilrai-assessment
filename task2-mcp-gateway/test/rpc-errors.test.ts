import { describe, expect, it } from 'vitest';
import { RpcCode, rpcError, type RpcCodeValue } from '../src/rpc-errors.js';

describe('rpcError', () => {
  it.each([
    [RpcCode.ParseError, -32700, 'Parse error'],
    [RpcCode.InvalidRequest, -32600, 'Invalid Request'],
    [RpcCode.MethodNotFound, -32601, 'Method not found'],
    [RpcCode.InvalidParams, -32602, 'Invalid params'],
    [RpcCode.InternalError, -32603, 'Internal error'],
    [RpcCode.UnauthorizedToolCall, -32001, 'Unauthorized Tool Call'],
  ])('builds %i with its fixed message', (code, number, message) => {
    const response = rpcError(1, code);
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, error: { code: number, message } });
    expect(Object.keys(response.error)).toEqual(['code', 'message']);
  });

  it.each([null, '', 0, 'x'])('echoes the id %j exactly', (id) => {
    expect(rpcError(id, RpcCode.InvalidRequest).id).toBe(id);
  });

  it('returns a fresh object each time', () => {
    const first = rpcError(1, RpcCode.InvalidRequest);
    first.error.message = 'changed';
    expect(rpcError(1, RpcCode.InvalidRequest).error.message).toBe('Invalid Request');
  });

  it('falls back to Internal error for a code outside the set', () => {
    expect(rpcError(1, -32099 as RpcCodeValue)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error' },
    });
  });
});
