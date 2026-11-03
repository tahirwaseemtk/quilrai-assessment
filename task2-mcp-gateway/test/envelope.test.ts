import { describe, expect, it } from 'vitest';
import { classifyBody } from '../src/envelope.js';

// Special characters are built from code points so no literal escape or invisible character
// appears in this source file.
const BS = String.fromCharCode(92);
const BOM = String.fromCodePoint(0xfeff);
const NUL = String.fromCodePoint(0);

type Id = string | number | null;
const E = (id: Id, code: number, message: string) => ({
  kind: 'reply',
  response: { jsonrpc: '2.0', id, error: { code, message } },
});
const P = E(null, -32700, 'Parse error');
const IR = (id: Id = null) => E(id, -32600, 'Invalid Request');
const IP = (id: Id) => E(id, -32602, 'Invalid params');
const DROP = { kind: 'drop' };

const B = (fields: string) => `{"jsonrpc":"2.0"${fields ? `,${fields}` : ''}}`;
const C = (params: string, id = '4') =>
  `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":${params}}`;
const ping = B('"id":1,"method":"ping"');

function expectReply(body: string, expected: unknown): void {
  const result = classifyBody(body);
  expect(result).toEqual(expected);
  expect(JSON.stringify(result)).not.toMatch(/issues|ZodError|expected|received|path|at \w+ \(/);
}

const request = (body: string, id: Id, method: string) => ({
  kind: 'request',
  message: JSON.parse(body) as unknown,
  id,
  method,
});
const call = (body: string, id: Id, toolName: string) => ({
  kind: 'tool-call',
  message: JSON.parse(body) as unknown,
  id,
  toolName,
});

describe('classifyBody: requests', () => {
  it.each(['1', '0', '-1', '"x"', '""', '9007199254740991', '-9007199254740991'])(
    'accepts id %s',
    (id) => {
      const body = B(`"id":${id},"method":"tools/list"`);
      const result = classifyBody(body);
      expect(result).toEqual(request(body, JSON.parse(id) as Id, 'tools/list'));
      expect('toolName' in result).toBe(false);
    },
  );

  it.each([
    ['1.0', 1],
    ['1e2', 100],
  ])('accepts the integer number form %s', (literal, id) => {
    expect(classifyBody(B(`"id":${literal},"method":"x"`))).toMatchObject({ kind: 'request', id });
  });

  it('keeps -0 as an id, and serializes it as 0 in a reply', () => {
    const result = classifyBody(B('"id":-0,"method":"x"'));
    expect(result.kind === 'request' && Object.is(result.id, -0)).toBe(true);
    expect(JSON.stringify(classifyBody(B('"id":-0,"method":"x","params":1')))).toContain('"id":0');
  });

  it('accepts a 1,000,000-character string id', () => {
    const id = 'a'.repeat(1_000_000);
    expect(classifyBody(B(`"id":"${id}","method":"x"`))).toMatchObject({ kind: 'request', id });
  });

  it('keeps loose params and _meta, in order', () => {
    const body = B(
      '"id":1,"method":"ping","params":{"_meta":{"progressToken":1},"note":"café 😀"}',
    );
    const result = classifyBody(body);
    expect(result).toEqual(request(body, 1, 'ping'));
    expect(
      Object.keys((result as unknown as { message: { params: object } }).message.params),
    ).toEqual(['_meta', 'note']);
  });

  it.each(['', 'rpc.x', 'tools/list', 'tool/call'])(
    'leaves method %j for the downstream to resolve',
    (method) => {
      const body = B(`"id":1,"method":${JSON.stringify(method)}`);
      const result = classifyBody(body);
      expect(result).toEqual(request(body, 1, method));
      expect('toolName' in result).toBe(false);
    },
  );

  it('reads escaped JSON as the client meant it', () => {
    expect(
      classifyBody(
        `{"jsonrpc":"2.0","id":4,"method":"tools${BS}/call","params":{"name":"${BS}u0061dmin"}}`,
      ),
    ).toMatchObject({
      kind: 'tool-call',
      toolName: 'admin',
    });
    expect(
      classifyBody(`{"jsonrpc":"2.0","id":4,"method":"${BS}u0074ools/call","params":{"name":"x"}}`),
    ).toMatchObject({
      kind: 'tool-call',
      toolName: 'x',
    });
  });

  it.each([
    C('{"name":"get_status","name":"admin"}'),
    '{"jsonrpc":"2.0","id":4,"method":"tools/list","method":"tools/call","params":{"name":"admin"}}',
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"x"},"params":{"name":"admin"}}',
  ])('refuses duplicated keys, which parsers resolve differently: %s', (body) => {
    expectReply(body, IR());
  });

  it.each([`  ${ping}\t\r\n`, `${BOM}${ping}`])(
    'tolerates JSON whitespace and one byte order mark: %j',
    (body) => {
      expect(classifyBody(body)).toEqual(request(ping, 1, 'ping'));
    },
  );
});

describe('classifyBody: notifications and responses', () => {
  it.each([
    B('"method":"notifications/initialized"'),
    B('"method":"x","params":{}'),
    B('"method":"x","params":{"_meta":{}}'),
  ])('forwards the notification %s', (body) => {
    const parsed = JSON.parse(body) as { method: string };
    expect(classifyBody(body)).toEqual({
      kind: 'notification',
      message: parsed,
      method: parsed.method,
    });
  });

  it.each([
    B('"id":1,"result":{}'),
    B('"id":"a","error":{"code":-1,"message":"x"}'),
    B('"id":1,"error":{"code":-1,"message":"x","data":{"k":1}}'),
    B('"id":1,"error":{"code":1,"message":"x","extra":1}'),
  ])('forwards the client response %s untouched', (body) => {
    expect(classifyBody(body)).toEqual({ kind: 'response', message: JSON.parse(body) as unknown });
  });
});

describe('classifyBody: -32700', () => {
  it.each([
    '',
    '   ',
    BOM,
    `${BOM}  `,
    '{bad',
    '{"a":1',
    '{"a":1,}',
    "'x'",
    'NaN',
    'Infinity',
    'undefined',
    '0x1',
    '{"id":01}',
    '// c\n{}',
    '{}{}',
    '{} {}',
    `${ping} {"x":1}`,
    `${ping}x`,
    `${ping}\n,`,
    '{"jsonrpc":"2.0","id":5,"method":',
    `{"a":"${NUL}"}`,
    `{"a":${BOM}1}`,
  ])('replies Parse error with id null for %j', (body) => {
    expectReply(body, P);
  });
});

describe('classifyBody: -32600', () => {
  it.each(['1', '"x"', '"[]"', 'null', 'true', 'false', '1e400'])(
    'rejects the non-object %s',
    (body) => {
      expectReply(body, IR());
    },
  );

  it.each([
    '{}',
    '{"foo":1}',
    B(''),
    B('"params":{}'),
    '{"jsonrpc":"2.0","__proto__":{"id":1,"method":"x"}}',
  ])('rejects %s with id null', (body) => {
    expectReply(body, IR());
    expect(({} as Record<string, unknown>).method).toBeUndefined();
  });

  it.each([
    '',
    '"jsonrpc":"1.0",',
    '"jsonrpc":2,',
    '"jsonrpc":"2",',
    '"jsonrpc":"2.0 ",',
    '"jsonrpc":null,',
  ])('rejects a bad version (%s) and echoes the id', (version) => {
    expectReply(`{${version}"id":7,"method":"ping"}`, IR(7));
  });

  it.each(['1', 'null', 'true', '{}', '[]'])('rejects method %s and echoes the id', (method) => {
    expectReply(B(`"id":"a","method":${method}`), IR('a'));
  });

  it('rejects an id without a method and echoes the id', () => {
    for (const body of ['{"id":7}', B('"id":7'), B('"id":7,"params":{}')]) expectReply(body, IR(7));
    expectReply(B('"id":"a"'), IR('a'));
  });

  it.each([B('"method":1,"params":"bar"'), B('"method":null')])(
    'replies (not drops) for a non-string method without an id: %s',
    (body) => {
      expectReply(body, IR());
    },
  );

  it.each([
    'null',
    'true',
    '{}',
    '[]',
    '1.5',
    '9007199254740992',
    '9007199254740993',
    '-9007199254740992',
    '1e400',
  ])('replies id null for the unusable id %s', (id) => {
    expectReply(B(`"id":${id},"method":"ping"`), IR());
  });

  it.each(['"bar"', '""', 'null', '1', 'true', '[]', '[1]'])('rejects params %s', (params) => {
    expectReply(B(`"id":7,"method":"ping","params":${params}`), IR(7));
  });

  it.each([
    '"extra":1',
    '"__proto__":{"polluted":1}',
    '"constructor":1',
    '"prototype":1',
    '"result":{}',
    '"error":{"code":1,"message":"x"}',
  ])('rejects the unknown top-level key %s', (extra) => {
    expectReply(B(`"id":7,"method":"ping",${extra}`), IR(7));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    '[]',
    '[ ]',
    `${BOM}[]`,
    '[1,2]',
    '[[]]',
    `[${B('"id":1,"method":"tools/list"')}]`,
    `[${ping},${ping}]`,
    `[${C('{"name":"admin"}', '1')}]`,
    `[${B('"method":"notifications/initialized"')}]`,
  ])('rejects the batch %s as a whole', (body) => {
    const result = classifyBody(body);
    expect(result).toEqual(IR());
    expect('message' in result || 'toolName' in result).toBe(false);
  });
});

describe('classifyBody: tools/call params', () => {
  it.each([
    ['{"name":"x"}', 'x'],
    ['{"name":"x","arguments":{}}', 'x'],
    ['{"name":"x","arguments":{"a":1}}', 'x'],
    ['{"name":"x","_meta":{}}', 'x'],
    ['{"name":"x","foo":1}', 'x'],
    ['{"name":"x","task":{"ttl":1}}', 'x'],
    ['{"name":""}', ''],
    ['{"name":"__proto__"}', '__proto__'],
    ['{"name":"admin"}', 'admin'],
  ])('passes params %s with toolName %j (name rules are applied in 2.5)', (params, name) => {
    const body = C(params);
    expect(classifyBody(body)).toEqual(call(body, 4, name));
  });

  it.each([
    'missing',
    '{}',
    '{"name":1}',
    '{"name":null}',
    '{"name":[]}',
    '{"name":{}}',
    '{"name":true}',
    '{"name":"x","arguments":null}',
    '{"name":"x","arguments":[]}',
    '{"name":"x","arguments":"s"}',
    '{"name":"x","arguments":1}',
    '{"name":"x","arguments":true}',
    '{"name":"x","_meta":5}',
  ])('replies -32602 for params %s and echoes the id', (params) => {
    const body = params === 'missing' ? B('"id":4,"method":"tools/call"') : C(params);
    expectReply(body, IP(4));
  });

  it('lets envelope errors take precedence over params errors', () => {
    expectReply(C('[]'), IR(4));
    expectReply(C('null'), IR(4));
    expectReply('{"jsonrpc":"2.0","id":null,"method":"tools/call"}', IR());
    expectReply(`${C('{"name":"x"}').slice(0, -1)},"extra":1}`, IR(4));
  });

  it.each([
    ['"q"', 'q'],
    ['0', 0],
    ['""', ''],
  ])('echoes id %s in -32602', (literal, id) => {
    expectReply(B(`"id":${literal},"method":"tools/call"`), IP(id));
  });

  it('reads the tool name from the own property, never the prototype', () => {
    const own = classifyBody(C('{"name":"x","__proto__":{"name":"admin"}}'));
    expect(own).toMatchObject({ kind: 'tool-call', toolName: 'x' });
    expect(
      Object.hasOwn(
        (own as unknown as { message: { params: object } }).message.params,
        '__proto__',
      ),
    ).toBe(true);
    expectReply(C('{"__proto__":{"name":"admin"}}'), IP(4));
  });

  it('rejects an own __proto__ key in arguments, as Task 1 does', () => {
    expectReply(C('{"name":"x","arguments":{"__proto__":{"polluted":true}}}'), IP(4));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not modify the parsed message', () => {
    const body = C('{"name":"x","arguments":{"a":[1,{"b":2}]}}');
    const first = classifyBody(body);
    expect(JSON.stringify((first as { message: unknown }).message)).toBe(
      JSON.stringify(JSON.parse(body)),
    );
    expect(classifyBody(body)).toEqual(first);
  });
});

describe('classifyBody: dropped input', () => {
  it.each([
    B('"method":"x","params":"bad"'),
    B('"method":"x","params":null'),
    B('"method":"x","params":[]'),
    B('"method":"x","extra":1'),
    '{"jsonrpc":"1.0","method":"x"}',
    '{"method":"x"}',
    B('"method":"x","__proto__":{}'),
  ])('drops the invalid notification %s', (body) => {
    expect(classifyBody(body)).toEqual(DROP);
  });

  it.each([
    B('"method":"tools/call"'),
    B('"method":"tools/call","params":{}'),
    B('"method":"tools/call","params":{"name":1}'),
    B('"method":"tools/call","params":{"name":"x","arguments":[]}'),
    B('"method":"tools/call","params":{"__proto__":{"name":"admin"}}'),
    B('"method":"tools/call","params":{"name":"admin"}'),
    B('"method":"tools/call","params":{"name":"get_status"}'),
  ])('drops every tools/call notification, valid or not: %s', (body) => {
    expect(classifyBody(body)).toEqual(DROP);
  });

  it('treats id:null as a request, not a notification', () => {
    expectReply(B('"id":null,"method":"x"'), IR());
  });

  it.each([
    B('"id":7,"result":{},"error":{"code":1,"message":"x"}'),
    B('"id":null,"error":{"code":1,"message":"x"}'),
    B('"id":1,"result":5'),
    B('"id":1,"result":null'),
    B('"id":1,"result":[]'),
    B('"id":1,"error":{"code":"1","message":"x"}'),
    B('"id":1,"error":{"code":1}'),
    B('"id":1,"result":{},"extra":1'),
    '{"id":1,"result":{}}',
  ])('drops the invalid response %s', (body) => {
    expect(classifyBody(body)).toEqual(DROP);
  });
});

describe('classifyBody: size and shape limits', () => {
  it('classifies a 1 MB argument quickly', () => {
    const body = C(`{"name":"x","arguments":{"blob":"${'a'.repeat(1_000_000)}"}}`);
    const start = performance.now();
    expect(classifyBody(body)).toMatchObject({ kind: 'tool-call', toolName: 'x' });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('classifies deeply nested arguments without overflowing the stack', () => {
    const depth = 100_000;
    const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const body = C(`{"name":"x","arguments":${nested}}`);
    expect(() => classifyBody(body)).not.toThrow();
  });

  it.each([
    ['1 MB of spaces', ' '.repeat(1_000_000), P],
    ['an unterminated array', '['.repeat(500_000), P],
    ['a 100k-request batch', `[${Array<string>(100_000).fill(ping).join(',')}]`, IR()],
  ])('rejects %s quickly', (_label, body, expected) => {
    const start = performance.now();
    expect(classifyBody(body)).toEqual(expected);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('classifyBody: parser-differential defenses', () => {
  const NBSP = String.fromCodePoint(0xa0);
  const LINE_SEPARATOR = String.fromCodePoint(0x2028);

  it.each([
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/list","params":{"name":"admin_x"}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/list","method":"tools/call","params":{"name":"admin_x"}}',
    '{"jsonrpc":"2.0","method":"tools/call","method":"notifications/initialized","params":{"name":"admin_x"}}',
    '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}',
    C('{"name":"x","arguments":{"a":1,"a":2}}'),
    C('{"name":"x","arguments":{"deep":[{"k":1,"k":2}]}}'),
    C(`{"name":"get_status","na${BS}u006de":"admin"}`),
  ])('refuses the duplicated key in %s with id null', (body) => {
    expectReply(body, IR());
  });

  it('allows the same key in different objects and quoted colons in values', () => {
    const body = C('{"name":"x","arguments":{"name":"y","nested":{"name":"z"},"text":"a\\":b"}}');
    expect(classifyBody(body)).toMatchObject({ kind: 'tool-call', toolName: 'x' });
  });

  it.each([`${BOM}${BOM}${ping}`, `${NBSP}${ping}`, `${LINE_SEPARATOR}${ping}`, `${ping}${NBSP}`])(
    'rejects characters a downstream JSON parser would reject: %j',
    (body) => {
      expectReply(body, P);
    },
  );

  it('answers -32602 for a request the downstream SDK would drop silently', () => {
    expectReply(B('"id":1,"method":"ping","params":{"_meta":5}'), IP(1));
  });

  it('drops a notification the downstream SDK would reject', () => {
    expect(classifyBody(B('"method":"notifications/x","params":{"_meta":5}'))).toEqual(DROP);
  });
});

describe('classifyBody: duplicate keys in notification- and response-shaped bodies', () => {
  it.each([
    '{"jsonrpc":"2.0","method":"notifications/initialized","method":"x"}',
    '{"jsonrpc":"2.0","id":1,"result":{},"result":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{"a":1,"a":2}}',
  ])('replies -32600 with id null rather than dropping %s', (body) => {
    expectReply(body, IR());
  });
});

describe('classifyBody: security review follow-ups', () => {
  const char = (codePoint: number): string => String.fromCodePoint(codePoint);

  it.each([
    C('{"name":"echo","NAME":"admin_delete"}'),
    C('{"name":"echo","Name":"admin_delete"}'),
    C(
      `{"name":"echo","${char(0xff4e)}${char(0xff41)}${char(0xff4d)}${char(0xff45)}":"admin_delete"}`,
    ),
    C(`{"name":"x","arguments":{"s":1,"${char(0x17f)}":2}}`),
    C(`{"name":"x","arguments":{"k":1,"${char(0x212a)}":2}}`),
  ])('refuses keys that a case-folding or normalizing parser would merge: %s', (body) => {
    expectReply(body, IR());
  });

  it.each(['Tools/Call', 'TOOLS/CALL', ' tools/call', 'tools/call ', `tools/${char(0xff43)}all`])(
    'refuses the tools/call lookalike method %j and echoes the id',
    (method) => {
      expectReply(
        B(`"id":3,"method":${JSON.stringify(method)},"params":{"name":"admin_x"}}`.slice(0, -1)),
        IR(3),
      );
    },
  );

  it.each(['Tools/Call', ' tools/call'])(
    'drops a notification with the lookalike method %j',
    (method) => {
      expect(
        classifyBody(B(`"method":${JSON.stringify(method)},"params":{"name":"admin_x"}`)),
      ).toEqual(DROP);
    },
  );

  it.each(['constructor', `admin${char(0xd800)}`])(
    'returns the tool name %j unchanged for the 2.5 name check',
    (name) => {
      expect(classifyBody(C(JSON.stringify({ name })))).toMatchObject({
        kind: 'tool-call',
        toolName: name,
      });
    },
  );
});
