import { describe, expect, it } from 'vitest';
import { classifyInbound } from '../src/inbound.js';

const reply = (id: string | number | null, code: number, message: string) => ({
  kind: 'reply',
  response: { jsonrpc: '2.0', id, error: { code, message } },
});
const parseError = reply(null, -32700, 'Parse error');
const invalidRequest = (id: string | number | null = null) => reply(id, -32600, 'Invalid Request');
const invalidParams = (id: string | number) => reply(id, -32602, 'Invalid params');
const drop = { kind: 'drop' };

const expectMessage = (line: string): void => {
  expect(classifyInbound(line)).toEqual({ kind: 'message', message: JSON.parse(line) as unknown });
};

describe('classifyInbound: valid messages', () => {
  it.each(['1', '0', '-1', '"abc"', '""'])('accepts a request with id %s', (id) => {
    expectMessage(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`);
  });

  it('accepts a notification', () => {
    expectMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  });

  it.each([
    '{"jsonrpc":"2.0","id":1,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}',
  ])('accepts a client response %s', (line) => {
    expectMessage(line);
  });

  it('keeps loose params, _meta and unicode', () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"progressToken":1},"note":"café 😀"}}';
    expectMessage(line);
  });

  it('ignores surrounding whitespace', () => {
    expect(classifyInbound('  {"jsonrpc":"2.0","id":1,"method":"ping"}\t')).toEqual({
      kind: 'message',
      message: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
  });

  it('strips a leading byte order mark', () => {
    expect(classifyInbound('\uFEFF{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      kind: 'message',
      message: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
  });

  it.each([
    '{"jsonrpc":"2.0","id":1,"method":""}',
    '{"jsonrpc":"2.0","id":1,"method":"TOOLS/CALL"}',
  ])('leaves method resolution to the SDK: %s', (line) => {
    expectMessage(line);
  });
});

describe('classifyInbound: parse errors', () => {
  it.each([
    '{bad json',
    '{"a":1',
    '{"a":1,}',
    "'x'",
    'NaN',
    'undefined',
    '{"jsonrpc":"2.0","id":1,"method":"ping"} {"x":1}',
    '{"jsonrpc":"2.0","id":5,"method":',
  ])('replies -32700 with id null for %s', (line) => {
    expect(classifyInbound(line)).toEqual(parseError);
  });
});

describe('classifyInbound: invalid requests', () => {
  it.each(['1', '"x"', 'null', 'true', '{}', '{"foo":1}'])(
    'replies -32600 id null for non-envelope %s',
    (line) => {
      expect(classifyInbound(line)).toEqual(invalidRequest());
    },
  );

  it.each([
    '{"id":7,"method":"ping"}',
    '{"jsonrpc":"1.0","id":7,"method":"ping"}',
    '{"jsonrpc":2,"id":7,"method":"ping"}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","params":"bar"}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","params":null}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","params":1}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","params":[]}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","extra":1}',
    '{"jsonrpc":"2.0","id":7,"method":"ping","result":{}}',
  ])('echoes a valid id in -32600 for %s', (line) => {
    expect(classifyInbound(line)).toEqual(invalidRequest(7));
  });

  it.each([
    '{"jsonrpc":"2.0","id":"a"}',
    '{"jsonrpc":"2.0","id":"a","method":1}',
    '{"jsonrpc":"2.0","id":"a","method":null}',
  ])('echoes a string id for a bad method: %s', (line) => {
    expect(classifyInbound(line)).toEqual(invalidRequest('a'));
  });

  it.each(['null', 'true', '{}', '[]', '1.5', '9007199254740993', '1e400'])(
    'replies id null for unusable id %s',
    (id) => {
      expect(classifyInbound(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`)).toEqual(
        invalidRequest(),
      );
    },
  );

  it('rejects a __proto__ key without polluting Object.prototype', () => {
    expect(
      classifyInbound('{"jsonrpc":"2.0","id":7,"method":"ping","__proto__":{"polluted":1}}'),
    ).toEqual(invalidRequest(7));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(['[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '[1,2]'])(
    'rejects batch %s with a single -32600',
    (line) => {
      expect(classifyInbound(line)).toEqual(invalidRequest());
    },
  );

  it('replies to an invalid message with a non-string method and no id', () => {
    expect(classifyInbound('{"jsonrpc":"2.0","method":1,"params":"bar"}')).toEqual(
      invalidRequest(),
    );
  });
});

describe('classifyInbound: dropped input', () => {
  it.each([
    '{"jsonrpc":"2.0","method":"notifications/x","params":"bad"}',
    '{"jsonrpc":"2.0","method":"x","extra":1}',
    '{"jsonrpc":"1.0","method":"x"}',
    '{"jsonrpc":"2.0","method":"tools/call"}',
  ])('drops invalid notification %s', (line) => {
    expect(classifyInbound(line)).toEqual(drop);
  });

  it.each([
    '{"jsonrpc":"2.0","id":7,"result":{},"error":{"code":1,"message":"x"}}',
    '{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"x"}}',
    '{"jsonrpc":"2.0","id":1,"result":5}',
  ])('drops invalid response %s', (line) => {
    expect(classifyInbound(line)).toEqual(drop);
  });
});

describe('classifyInbound: tools/call params', () => {
  const call = (params?: string): string =>
    `{"jsonrpc":"2.0","id":4,"method":"tools/call"${params === undefined ? '' : `,"params":${params}`}}`;

  it.each([
    undefined,
    '{}',
    '{"name":1}',
    '{"name":null}',
    '{"name":[]}',
    '{"name":"x","arguments":null}',
    '{"name":"x","arguments":[]}',
    '{"name":"x","arguments":"s"}',
    '{"name":"x","arguments":1}',
  ])('replies -32602 with a fixed message for params %s', (params) => {
    const result = classifyInbound(call(params));
    expect(result).toEqual(invalidParams(4));
    expect(JSON.stringify(result)).not.toMatch(/issues|ZodError|expected|path/);
  });

  it.each([
    '{"name":"x"}',
    '{"name":"x","arguments":{}}',
    '{"name":"x","arguments":{"a":1}}',
    '{"name":"x","_meta":{}}',
    '{"name":"x","foo":1}',
    '{"name":""}',
  ])('passes structurally valid params %s', (params) => {
    expectMessage(call(params));
  });

  it('passes __proto__ inside arguments without polluting Object.prototype', () => {
    const result = classifyInbound(
      call('{"name":"x","arguments":{"__proto__":{"polluted":true}}}'),
    );
    expect(result.kind).toBe('message');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('classifyInbound: SDK schema parity', () => {
  it.each([
    '{"jsonrpc":"2.0","id":12,"method":"ping","params":{"_meta":5}}',
    '{"jsonrpc":"2.0","id":12,"method":"ping","params":{"_meta":null}}',
    '{"jsonrpc":"2.0","id":12,"method":"tools/list","params":{"_meta":[]}}',
    '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"x","_meta":{"progressToken":{}}}}',
    '{"jsonrpc":"2.0","id":12,"method":"custom/method","params":{"_meta":5}}',
  ])('answers a request the SDK would silently drop: %s', (line) => {
    expect(classifyInbound(line)).toEqual(invalidParams(12));
  });

  it.each([
    '{"jsonrpc":"2.0","id":13,"method":"tools/list","params":{"cursor":5}}',
    '{"jsonrpc":"2.0","id":13,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":13,"method":"initialize"}',
    '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"x","task":{"ttl":1000}}}',
  ])('answers invalid params on SDK-validated methods with -32602: %s', (line) => {
    expect(classifyInbound(line)).toEqual(invalidParams(13));
  });

  it.each([
    '{"jsonrpc":"2.0","id":14,"method":"tools/list","params":{"cursor":"abc"}}',
    '{"jsonrpc":"2.0","id":14,"method":"ping","params":{}}',
    '{"jsonrpc":"2.0","id":14,"method":"ping","params":{"_meta":{"progressToken":"t"}}}',
  ])('passes valid params on SDK-validated methods: %s', (line) => {
    expectMessage(line);
  });

  it('drops a notification the SDK would reject', () => {
    expect(
      classifyInbound('{"jsonrpc":"2.0","method":"notifications/x","params":{"_meta":5}}'),
    ).toEqual(drop);
  });

  it('drops a response the SDK would reject', () => {
    expect(classifyInbound('{"jsonrpc":"2.0","id":23,"result":{"_meta":5}}')).toEqual(drop);
  });
});
