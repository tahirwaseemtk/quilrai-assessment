import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../src/read-body.js';
import { startCaptureDownstream, type CaptureDownstream } from './helpers/capture-downstream.js';
import {
  ADMIN_TOKEN,
  DOWNSTREAM_TOKEN,
  LIST,
  rpcErrorBody,
  startGateway,
  stdHeaders,
  stopGateways,
  VIEWER_TOKEN,
  type StartedGateway,
} from './helpers/gateway-harness.js';
import { rawRequest, type RawHeaders } from './helpers/raw-http.js';

let downstream: CaptureDownstream;
let started: StartedGateway;

beforeEach(async () => {
  downstream = await startCaptureDownstream();
  started = await startGateway({ downstreamUrl: downstream.url });
});

afterEach(async () => {
  await stopGateways();
  await downstream.close();
});

const call = (id: unknown, name: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...extra } });

const DENY = (id: unknown) => rpcErrorBody(id, -32001, 'Unauthorized Tool Call');
const BAD_NAME = (id: unknown) => rpcErrorBody(id, -32602, 'Invalid params');

const post = (body: Buffer | string, token = VIEWER_TOKEN, headers: RawHeaders = {}) =>
  rawRequest({ port: started.port, headers: stdHeaders(headers, token), body });

const cp = (...points: number[]) => String.fromCodePoint(...points);
const unit = (code: number) => String.fromCharCode(code);

describe('denied calls', () => {
  it.each([1, 'abc', 0, '', -1, '0', Number.MAX_SAFE_INTEGER])(
    'answers a viewer calling admin with -32001, echoing the id %j',
    async (id) => {
      const response = await post(call(id, 'admin'));
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.text).toBe(DENY(id));
      expect(downstream.requests).toHaveLength(0);
    },
  );

  it.each(['admin_reset_key', 'admin_', 'ADMIN', 'Admin_x', 'aDMIN_reset'])(
    'denies the viewer %s',
    async (name) => {
      const response = await post(call(7, name, { arguments: { key_id: 'k-1' } }));
      expect(response.status).toBe(200);
      expect(response.text).toBe(DENY(7));
      expect(downstream.requests).toHaveLength(0);
    },
  );

  it('denies a name written with a JSON escape, judged on the parsed string', async () => {
    const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin${unit(92)}u005fx"}}`;
    const response = await post(body);
    expect(response.text).toBe(DENY(1));
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([
    ['arguments present', { arguments: { key_id: 'k-1' } }],
    ['arguments empty', { arguments: {} }],
    ['no arguments', {}],
    ['_meta present', { _meta: { progressToken: 'p' } }],
  ])('denies with %s', async (_label, extra) => {
    const response = await post(call(2, 'admin_reset_key', extra));
    expect(response.text).toBe(DENY(2));
    expect(downstream.requests).toHaveLength(0);
  });

  it('leaks nothing about the tool, token, role or downstream in the response', async () => {
    const response = await post(call(1, 'admin_reset_key'));
    const everything = response.text + JSON.stringify(response.headers);
    for (const secret of [
      'admin_reset_key',
      VIEWER_TOKEN,
      DOWNSTREAM_TOKEN,
      'viewer',
      '127.0.0.1',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('takes the role only from the token table', async () => {
    const header = await post(call(1, 'admin'), VIEWER_TOKEN, { 'x-role': 'admin' });
    expect(header.text).toBe(DENY(1));
    const query = await rawRequest({
      port: started.port,
      path: '/mcp?role=admin',
      headers: stdHeaders(),
      body: call(2, 'admin'),
    });
    expect(query.text).toBe(DENY(2));
    expect(downstream.requests).toHaveLength(0);
  });

  it('decides per request, not per connection or token seen before', async () => {
    expect((await post(call(1, 'admin'), ADMIN_TOKEN)).status).toBe(200);
    expect((await post(call(2, 'admin'), VIEWER_TOKEN)).text).toBe(DENY(2));
    expect((await post(call(3, 'get_status'), VIEWER_TOKEN)).status).toBe(200);
    expect((await post(call(4, 'admin'), ADMIN_TOKEN)).status).toBe(200);
    expect(
      downstream.requests.map(
        (request) => (JSON.parse(request.body.toString()) as { id: number }).id,
      ),
    ).toEqual([1, 3, 4]);
  });

  it('handles concurrent denied and allowed calls independently', async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const responses = await Promise.all(
      ids.map((id) => post(call(id, id % 2 === 0 ? 'admin_x' : 'get_status'), VIEWER_TOKEN)),
    );
    for (const [index, response] of responses.entries()) {
      const id = ids[index] ?? 0;
      if (id % 2 === 0) expect(response.text).toBe(DENY(id));
      else expect(response.text).not.toContain('-32001');
    }
    expect(downstream.requests).toHaveLength(3);
  });
});

describe('allowed calls', () => {
  it('forwards an admin call byte for byte with the gateway credential', async () => {
    const body =
      '{ "jsonrpc":"2.0", "id":9,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"key_id":"k-1"}} }';
    const response = await post(body, ADMIN_TOKEN);
    expect(response.status).toBe(200);
    expect(downstream.requests).toHaveLength(1);
    expect(downstream.requests[0]?.body.equals(Buffer.from(body))).toBe(true);
    expect(downstream.requests[0]?.headers.authorization).toBe(`Bearer ${DOWNSTREAM_TOKEN}`);
  });

  it.each(['get_status', 'adminx', 'administrator', 'xadmin', 'admin.x', 'admin-x'])(
    'forwards the viewer call %s byte for byte',
    async (name) => {
      const body = call(1, name);
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(downstream.requests).toHaveLength(1);
      expect(downstream.requests[0]?.body.equals(Buffer.from(body))).toBe(true);
    },
  );

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'forwards the prototype-like name %s for both roles',
    async (name) => {
      for (const token of [VIEWER_TOKEN, ADMIN_TOKEN]) {
        const response = await post(call(5, name), token);
        expect(response.status).toBe(200);
      }
      expect(downstream.requests).toHaveLength(2);
    },
  );

  it.each([
    ['tools/list', LIST],
    ['ping', '{"jsonrpc":"2.0","id":2,"method":"ping"}'],
    ['initialize', '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}'],
    ['a method named admin', '{"jsonrpc":"2.0","id":4,"method":"admin"}'],
  ])('never gates %s', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(downstream.requests[0]?.body.equals(Buffer.from(body))).toBe(true);
  });
});

describe('tool-name check', () => {
  const invalid: [string, string][] = [
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a space inside', 'a b'],
    ['a trailing space after admin', 'admin '],
    ['a leading space', ' admin'],
    ['a fullwidth letter', cp(0xff41) + 'dmin'],
    ['NUL', 'a' + unit(0)],
    ['a trailing newline', 'a\n'],
    ['percent encoding', 'a%41'],
    ['a zero-width space', cp(0x200b) + 'admin'],
    ['a lone surrogate', 'a' + unit(0xd800)],
    ['the long s', cp(0x17f) + 'dmin'],
  ];

  it.each(invalid)('answers -32602 to %s for both roles, never -32001', async (_label, name) => {
    for (const token of [VIEWER_TOKEN, ADMIN_TOKEN]) {
      const response = await post(call(3, name), token);
      expect(response.status).toBe(200);
      expect(response.text).toBe(BAD_NAME(3));
    }
    expect(downstream.requests).toHaveLength(0);
  });

  it('accepts exactly 128 characters and gates an admin_ name of that length', async () => {
    expect((await post(call(1, 'a'.repeat(128)))).status).toBe(200);
    const long = 'admin_' + 'a'.repeat(122);
    expect((await post(call(2, long))).text).toBe(DENY(2));
    expect((await post(call(3, long), ADMIN_TOKEN)).status).toBe(200);
    expect(downstream.requests).toHaveLength(2);
  });

  it.each([
    ['name is a number', call(4, 5)],
    ['name is null', call(4, null)],
    ['name is missing', '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}'],
    ['params are missing', '{"jsonrpc":"2.0","id":4,"method":"tools/call"}'],
    ['arguments is an array', call(4, 'x', { arguments: [] })],
  ])('still answers -32602 when %s', async (_label, body) => {
    const response = await post(body);
    expect(response.text).toBe(BAD_NAME(4));
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('checks around the gate', () => {
  it.each([
    ['no Authorization', undefined],
    ['a wrong token', 'Bearer wrong-token-0123456789'],
    ['an empty bearer token', 'Bearer'],
  ])('answers 401 before the gate for %s', async (_label, authorization) => {
    const headers = stdHeaders();
    delete headers.authorization;
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await rawRequest({ port: started.port, headers, body: call(1, 'admin') });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.text).toBe('Unauthorized');
    expect(downstream.requests).toHaveLength(0);
  });

  it('keeps 415, 413 and the repeated-header 400 ahead of the gate', async () => {
    const body = call(1, 'admin');
    expect((await post(body, VIEWER_TOKEN, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post(body, VIEWER_TOKEN, { 'mcp-session-id': ['a', 'b'] })).status).toBe(400);
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([
    ['viewer', VIEWER_TOKEN],
    ['admin', ADMIN_TOKEN],
  ])('drops a tools/call notification for an admin tool from the %s', async (_label, token) => {
    for (const method of ['tools/call', 'Tools/Call']) {
      const body = `{"jsonrpc":"2.0","method":"${method}","params":{"name":"admin"}}`;
      const response = await post(body, token);
      expect(response.status).toBe(202);
      expect(response.text).toBe('');
    }
    expect(downstream.requests).toHaveLength(0);
  });

  it('refuses a lookalike method, a batch and duplicate keys before the gate', async () => {
    const lookalike = await post(
      '{"jsonrpc":"2.0","id":1,"method":" tools/call","params":{"name":"admin"}}',
    );
    expect(lookalike.status).toBe(400);
    expect(lookalike.text).toBe(rpcErrorBody(1, -32600, 'Invalid Request'));

    for (const token of [VIEWER_TOKEN, ADMIN_TOKEN]) {
      const batch = await post(`[${call(1, 'get_status')},${call(2, 'admin')}]`, token);
      expect(batch.status).toBe(400);
      expect(batch.text).toBe(rpcErrorBody(null, -32600, 'Invalid Request'));
    }

    const duplicate = await post(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","name":"admin"}}',
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.text).toBe(rpcErrorBody(null, -32600, 'Invalid Request'));
    expect(downstream.requests).toHaveLength(0);
  });

  it('forwards nothing for a tools/call whose id is null', async () => {
    const response = await post(
      '{"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"admin"}}',
    );
    expect([202, 400]).toContain(response.status);
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('logging', () => {
  it.each([
    ['a denied call', call(1, 'admin_reset_key'), 'admin_reset_key'],
    ['a bad name', call(1, 'a b'), 'a b'],
  ])('logs %s as one plain request line', async (_label, body, name) => {
    await post(body);
    const text = started.sink.chunks.join('');
    for (const secret of [name, VIEWER_TOKEN, DOWNSTREAM_TOKEN]) expect(text).not.toContain(secret);
    const lines = started.sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.msg === 'request')).toEqual([
      expect.objectContaining({ rpc_method: 'tools/call', status: 200, http_method: 'POST' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      [
        'duration_ms',
        'http_method',
        'level',
        'msg',
        'rpc_method',
        'service',
        'status',
        'time',
      ].sort(),
    );
  });
});
