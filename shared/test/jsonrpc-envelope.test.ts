import { describe, expect, it } from 'vitest';
import { argumentsHaveOwnProto, readEnvelope, stripByteOrderMark } from '../jsonrpc-envelope.js';

describe('readEnvelope', () => {
  it.each([
    ['{bad', { kind: 'parse-error' }],
    ['[]', { kind: 'invalid-request', id: null }],
    ['{"jsonrpc":"2.0","id":7}', { kind: 'invalid-request', id: 7 }],
    ['{"jsonrpc":"2.0","id":null,"method":"x"}', { kind: 'invalid-request', id: null }],
    ['{"jsonrpc":"2.0","method":"x","params":1}', { kind: 'invalid-notification' }],
    ['{"jsonrpc":"2.0","id":1,"result":5}', { kind: 'invalid-response' }],
  ])('classifies %s', (text, expected) => {
    expect(readEnvelope(text)).toEqual(expected);
  });

  it('returns the raw parsed object for valid messages', () => {
    const request = '{"jsonrpc":"2.0","id":1,"method":"x","params":{"__proto__":{"a":1}}}';
    const result = readEnvelope(request);
    expect(result).toMatchObject({ kind: 'request', id: 1, method: 'x' });
    const params = (result as unknown as { value: { params: object } }).value.params;
    expect(Object.hasOwn(params, '__proto__')).toBe(true);
    expect(readEnvelope('{"jsonrpc":"2.0","method":"n"}')).toEqual({
      kind: 'notification',
      value: { jsonrpc: '2.0', method: 'n' },
      method: 'n',
    });
    expect(readEnvelope('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      kind: 'response',
      value: { jsonrpc: '2.0', id: 1, result: {} },
    });
  });
});

describe('envelope helpers', () => {
  const BOM = String.fromCodePoint(0xfeff);

  it('strips exactly one leading byte order mark', () => {
    expect(stripByteOrderMark(`${BOM}{}`)).toBe('{}');
    expect(stripByteOrderMark(`${BOM}${BOM}{}`)).toBe(`${BOM}{}`);
    expect(stripByteOrderMark(`{}${BOM}`)).toBe(`{}${BOM}`);
  });

  it('reads JSON whitespace but not other Unicode spaces', () => {
    expect(readEnvelope(' \t\r\n{"jsonrpc":"2.0","method":"n"}\n').kind).toBe('notification');
    expect(readEnvelope(`${String.fromCodePoint(0xa0)}{"jsonrpc":"2.0","method":"n"}`)).toEqual({
      kind: 'parse-error',
    });
  });

  it.each([
    [{ name: 'x', arguments: JSON.parse('{"__proto__":{"a":1}}') as unknown }, true],
    [{ name: 'x', arguments: { a: 1 } }, false],
    [{ name: 'x' }, false],
    [{ name: 'x', arguments: [] }, false],
    [null, false],
  ])('detects an own __proto__ key in arguments: %j', (params, expected) => {
    expect(argumentsHaveOwnProto(params)).toBe(expected);
  });
});
