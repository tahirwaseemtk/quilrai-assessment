import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ArgumentMessage } from '../src/field-errors.js';
import { sanitizeOutbound } from '../src/outbound.js';

const asMessage = (value: unknown): JSONRPCMessage => value as JSONRPCMessage;
const withError = (error: Record<string, unknown>, id: unknown = 1): JSONRPCMessage =>
  asMessage({ jsonrpc: '2.0', id, error });

describe('sanitizeOutbound', () => {
  it.each([
    ['result', { jsonrpc: '2.0', id: 1, result: { tools: [] } }],
    ['request', { jsonrpc: '2.0', id: 9, method: 'ping' }],
    [
      'notification',
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } },
    ],
    [
      'tool error result',
      {
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'Customer not found' }], isError: true },
      },
    ],
  ])('passes a %s through unchanged without mutating it', (_label, value) => {
    const input = structuredClone(value);
    const output = sanitizeOutbound(asMessage(input));
    expect(output).toEqual(value);
    expect(input).toEqual(value);
  });

  it.each([
    [-32700, 'Parse error'],
    [-32600, 'Invalid Request'],
    [-32601, 'Method not found'],
    [-32602, 'Invalid params'],
    [-32602, 'Unknown tool'],
    [-32603, 'Internal error'],
  ])('keeps the allowlisted message for %i: %s', (code, message) => {
    expect(sanitizeOutbound(withError({ code, message }))).toEqual(withError({ code, message }));
  });

  it('removes the SDK "MCP error" prefix', () => {
    expect(
      sanitizeOutbound(withError({ code: -32602, message: 'MCP error -32602: Invalid params' })),
    ).toEqual(withError({ code: -32602, message: 'Invalid params' }));
  });

  it.each([
    [-32603, '[{"code":"invalid_type","path":["params","name"]}]', 'Internal error'],
    [-32602, 'Error: x\n    at f (C:\\a\\b.ts:1:1)', 'Invalid params'],
    [-32601, 'Unknown tool', 'Method not found'],
  ])('replaces non-allowlisted message under %i', (code, message, expected) => {
    expect(sanitizeOutbound(withError({ code, message }))).toEqual(
      withError({ code, message: expected }),
    );
  });

  it.each([-32000, -32099, -32001, 0, 1, -1])('maps unknown code %i to Internal error', (code) => {
    expect(sanitizeOutbound(withError({ code, message: 'boom /etc/x' }))).toEqual(
      withError({ code: -32603, message: 'Internal error' }),
    );
  });

  it.each([{ issues: ['x'] }, null])('strips data from errors: %j', (data) => {
    const output = sanitizeOutbound(withError({ code: -32602, message: 'Invalid params', data }));
    expect(Object.keys((output as { error: object }).error)).toEqual(['code', 'message']);
  });

  it.each(['s', null])('preserves the error id %j', (id) => {
    const output = sanitizeOutbound(withError({ code: -32603, message: 'x' }, id));
    expect((output as { id: unknown }).id).toBe(id);
  });

  it('keeps an absent id absent', () => {
    const output = sanitizeOutbound(
      asMessage({ jsonrpc: '2.0', error: { code: -32603, message: 'x' } }),
    );
    expect('id' in output).toBe(false);
  });
});

describe('sanitizeOutbound: field-level messages', () => {
  const amountMessage = `Invalid params: ${ArgumentMessage.Amount}`;

  it('keeps an allowed field-level message after removing the SDK prefix', () => {
    expect(
      sanitizeOutbound(withError({ code: -32602, message: `MCP error -32602: ${amountMessage}` })),
    ).toEqual(withError({ code: -32602, message: amountMessage }));
  });

  it('replaces a tampered field-level message with the canonical one', () => {
    expect(
      sanitizeOutbound(withError({ code: -32602, message: `${amountMessage}; leaked detail` })),
    ).toEqual(withError({ code: -32602, message: 'Invalid params' }));
  });

  it('replaces a field-level message under another code', () => {
    expect(sanitizeOutbound(withError({ code: -32603, message: amountMessage }))).toEqual(
      withError({ code: -32603, message: 'Internal error' }),
    );
  });
});
