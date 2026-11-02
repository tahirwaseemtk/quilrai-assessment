import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  ErrorMessage,
  RpcError,
  canonicalMessage,
  errorResponse,
  isSafeMessage,
} from '../src/errors.js';

describe('RpcError', () => {
  it('keeps the numeric code and the exact message without a prefix', () => {
    const error = new RpcError(-32602, 'Unknown tool');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RpcError');
    expect(error.code).toBe(-32602);
    expect(error.message).toBe('Unknown tool');
  });
});

describe('fixed messages', () => {
  it('exposes the standard JSON-RPC messages and the unknown-tool message', () => {
    expect(ErrorMessage).toEqual({
      ParseError: 'Parse error',
      InvalidRequest: 'Invalid Request',
      MethodNotFound: 'Method not found',
      InvalidParams: 'Invalid params',
      InternalError: 'Internal error',
      UnknownTool: 'Unknown tool',
    });
    expect(ErrorCode).toEqual({
      ParseError: -32700,
      InvalidRequest: -32600,
      MethodNotFound: -32601,
      InvalidParams: -32602,
      InternalError: -32603,
    });
  });

  it('allows messages per code only', () => {
    expect(isSafeMessage(-32602, 'Unknown tool')).toBe(true);
    expect(isSafeMessage(-32601, 'Unknown tool')).toBe(false);
    expect(isSafeMessage(-32603, 'Internal error')).toBe(true);
    expect(isSafeMessage(-32001, 'Internal error')).toBe(false);
  });

  it.each([
    [-32700, 'Parse error'],
    [-32600, 'Invalid Request'],
    [-32601, 'Method not found'],
    [-32602, 'Invalid params'],
    [-32603, 'Internal error'],
    [-32001, 'Internal error'],
  ])('canonical message for %i is %s', (code, message) => {
    expect(canonicalMessage(code)).toBe(message);
  });

  it('builds error responses with exactly jsonrpc, id and error', () => {
    expect(errorResponse(null, ErrorCode.ParseError)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });
});
