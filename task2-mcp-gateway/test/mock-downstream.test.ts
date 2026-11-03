import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../../shared/logger.js';
import { createMockDownstream, type MockDownstream } from '../mock-downstream/server.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { bearer, postRpc } from './helpers/mcp-http.js';

const TOKEN = 's3cret';
const toolNames = ['get_status', 'admin_reset_key', 'admin'];
const running: MockDownstream[] = [];

async function start(options: { jsonResponse?: boolean; sink?: CaptureSink } = {}) {
  const logger = createLogger({
    service: 'mock-downstream',
    sink: options.sink ?? new CaptureSink(),
  });
  const mock = createMockDownstream({
    authToken: TOKEN,
    logger,
    ...(options.jsonResponse === undefined ? {} : { jsonResponse: options.jsonResponse }),
  });
  running.push(mock);
  const { url } = await mock.listen();
  return { mock, url };
}

async function connectClient(url: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const rpc = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const call = (id: number | string, name: string, args: unknown = {}) =>
  rpc(id, 'tools/call', { name, arguments: args });

afterEach(async () => {
  await Promise.all(running.splice(0).map((mock) => mock.close()));
});

describe('createMockDownstream: setup', () => {
  it.each(['', '   '])('refuses an empty auth token %j', (authToken) => {
    expect(() =>
      createMockDownstream({ authToken, logger: createLogger({ service: 'mock-downstream' }) }),
    ).toThrow('authToken');
  });

  it('listens on a free port on 127.0.0.1', async () => {
    const { url } = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(Number(new URL(url).port)).toBeGreaterThan(0);
  });

  it('runs two mocks side by side', async () => {
    const first = await start();
    const second = await start();
    expect(first.url).not.toBe(second.url);
    for (const { url } of [first, second]) {
      expect((await postRpc(url, rpc(1, 'tools/list'), bearer(TOKEN))).status).toBe(200);
    }
  });
});

describe('createMockDownstream: SDK client', () => {
  it('initializes and lists exactly the three tools', async () => {
    const { mock, url } = await start();
    const client = await connectClient(url);
    expect(client.getServerVersion()?.name).toBe('mock-downstream');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(toolNames);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    await client.listTools();
    expect(mock.calls).toEqual([]);
    await client.close();
  });

  it('runs each tool and records exactly the executed calls, in order', async () => {
    const { mock, url } = await start();
    const client = await connectClient(url);
    const results = [
      await client.callTool({ name: 'get_status', arguments: {} }),
      await client.callTool({ name: 'admin_reset_key', arguments: { key_id: 'k-1' } }),
      await client.callTool({ name: 'admin', arguments: {} }),
    ];
    const payloads = results.map((result) => {
      expect(result.isError).toBeUndefined();
      return JSON.parse((result.content as { text: string }[])[0]?.text ?? '') as unknown;
    });
    expect(payloads).toEqual([{ status: 'ok' }, { reset: true, key_id: 'k-1' }, { admin: true }]);
    expect(mock.calls).toEqual([
      { name: 'get_status', arguments: {} },
      { name: 'admin_reset_key', arguments: { key_id: 'k-1' } },
      { name: 'admin', arguments: {} },
    ]);
    await client.close();
  });

  it('keeps recorded arguments as snapshots', async () => {
    const { mock, url } = await start();
    const args = { key_id: 'k-1' };
    const client = await connectClient(url);
    await client.callTool({ name: 'admin_reset_key', arguments: args });
    args.key_id = 'changed';
    const calls = mock.calls as unknown as { arguments: { key_id: string } }[];
    calls[0]!.arguments.key_id = 'tampered';
    expect(mock.calls).toEqual([{ name: 'admin_reset_key', arguments: { key_id: 'k-1' } }]);
    await client.close();
  });

  it('rejects an SDK client with the wrong token', async () => {
    const { mock, url } = await start();
    await expect(connectClient(url, 'wrong')).rejects.toMatchObject({ code: 401 });
    expect(mock.calls).toEqual([]);
  });
});

describe('createMockDownstream: raw HTTP', () => {
  it('answers tools/list without initialize (stateless)', async () => {
    const { url } = await start();
    const response = await postRpc(url, rpc(1, 'tools/list'), bearer(TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = response.json as { id: number; result: { tools: { name: string }[] } };
    expect(body.id).toBe(1);
    expect(body.result.tools.map((tool) => tool.name)).toEqual(toolNames);
  });

  it('answers tools/call and records it', async () => {
    const { mock, url } = await start();
    const response = await postRpc(url, call('a', 'get_status'), bearer(TOKEN));
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      id: 'a',
      result: { content: [{ type: 'text', text: '{"status":"ok"}' }] },
    });
    expect(mock.calls).toHaveLength(1);
  });

  it.each([0, -1, 'x', ''])('echoes id %j exactly', async (id) => {
    const { url } = await start();
    const response = await postRpc(url, rpc(id, 'tools/list'), bearer(TOKEN));
    expect((response.json as { id: unknown }).id).toBe(id);
  });

  it.each([
    ['unknown tool', call(1, 'nope'), -32602, 'Unknown tool'],
    ['missing key_id', call(1, 'admin_reset_key', {}), -32602, 'Invalid params'],
    ['extra argument', call(1, 'get_status', { x: 1 }), -32602, 'Invalid params'],
    ['unknown method', rpc(2, 'foo/bar'), -32601, undefined],
  ])(
    'answers %s with a JSON-RPC error and records nothing',
    async (_label, body, code, message) => {
      const { mock, url } = await start();
      const response = await postRpc(url, body, bearer(TOKEN));
      expect(response.status).toBe(200);
      expect((response.json as { error: { code: number } }).error.code).toBe(code);
      if (message)
        expect((response.json as { error: { message: string } }).error.message).toBe(message);
      expect(mock.calls).toEqual([]);
    },
  );

  it('handles a batch of tool calls', async () => {
    const { mock, url } = await start();
    const response = await postRpc(url, [call(1, 'get_status'), call(2, 'admin')], bearer(TOKEN));
    expect(response.status).toBe(200);
    expect((response.json as { id: number }[]).map((item) => item.id).sort()).toEqual([1, 2]);
    expect(mock.calls.map((entry) => entry.name)).toEqual(['get_status', 'admin']);
  });

  it('accepts a notification with 202 and no body', async () => {
    const { url } = await start();
    const response = await postRpc(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      bearer(TOKEN),
    );
    expect(response.status).toBe(202);
    expect(response.text).toBe('');
  });

  it('routes by pathname, ignoring the query string', async () => {
    const { url } = await start();
    expect((await postRpc(`${url}?x=1`, rpc(1, 'tools/list'), bearer(TOKEN))).status).toBe(200);
  });
});

describe('createMockDownstream: downstream credential', () => {
  it.each([
    ['missing header', {}],
    ['Basic scheme', { authorization: 'Basic czNjcmV0' }],
    ['wrong token', bearer('wrong')],
    ['a gateway client token', bearer('client-admin-token')],
    ['empty bearer', { authorization: 'Bearer ' }],
  ])('rejects %s with 401 and runs nothing', async (_label, headers) => {
    const { mock, url } = await start();
    const response = await postRpc(url, call(1, 'admin_reset_key', { key_id: 'k' }), headers);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.text).toBe('Unauthorized');
    expect(mock.calls).toEqual([]);
  });

  it('checks the credential before parsing the body', async () => {
    const { url } = await start();
    expect((await postRpc(url, '{bad json', bearer('wrong'), { raw: true })).status).toBe(401);
  });

  it('accepts a lowercase bearer scheme', async () => {
    const { url } = await start();
    const response = await postRpc(url, rpc(1, 'tools/list'), { authorization: `bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });
});

describe('createMockDownstream: routing', () => {
  it.each(['/', '/mcp/', '/mcpx', '/MCP', '/other'])('answers 404 for %s', async (path) => {
    const { mock, url } = await start();
    const response = await postRpc(
      new URL(path, url).toString(),
      rpc(1, 'tools/list'),
      bearer(TOKEN),
    );
    expect(response.status).toBe(404);
    expect(mock.calls).toEqual([]);
  });

  it.each(['GET', 'DELETE', 'PUT', 'PATCH'])('answers 405 for %s on /mcp', async (method) => {
    const { url } = await start();
    const response = await postRpc(url, undefined, bearer(TOKEN), { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.text).not.toContain('-32000');
  });
});

// Behavior of the SDK's HTTP transport, pinned so the gateway never relies on it: valid JSON that
// is not JSON-RPC comes back as -32700, not the -32600 the gateway must return (AC2.4).
describe('createMockDownstream: SDK transport behavior', () => {
  it.each([undefined, 'application/json', 'text/event-stream'])(
    'answers 406 when Accept is %j',
    async (accept) => {
      const { url } = await start();
      const headers: Record<string, string> = { ...bearer(TOKEN) };
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', ...(accept ? { accept } : {}) },
        body: JSON.stringify(rpc(1, 'tools/list')),
      });
      expect(response.status).toBe(406);
      expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32000);
    },
  );

  it('answers 415 for a non-JSON content type and accepts a charset', async () => {
    const { url } = await start();
    const wrong = await postRpc(url, rpc(1, 'tools/list'), {
      ...bearer(TOKEN),
      'content-type': 'text/plain',
    });
    expect(wrong.status).toBe(415);
    const charset = await postRpc(url, rpc(1, 'tools/list'), {
      ...bearer(TOKEN),
      'content-type': 'application/json; charset=utf-8',
    });
    expect(charset.status).toBe(200);
  });

  it.each(['{bad', '', '{"jsonrpc":"2.0","id":1,"method":"tools/list"'])(
    'answers 400 -32700 for malformed JSON %j',
    async (body) => {
      const { url } = await start();
      const response = await postRpc(url, body, bearer(TOKEN), { raw: true });
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ id: null, error: { code: -32700 } });
    },
  );

  it.each(['{}', '{"id":1}', '42', 'null', '{"jsonrpc":"1.0","id":1,"method":"x"}'])(
    'answers 400 -32700 (not -32600) for the non-JSON-RPC body %s',
    async (body) => {
      const { url } = await start();
      const response = await postRpc(url, body, bearer(TOKEN), { raw: true });
      expect(response.status).toBe(400);
      expect((response.json as { error: { code: number } }).error.code).toBe(-32700);
    },
  );

  it('rejects a batch of more than 100 messages', async () => {
    const { url } = await start();
    const batch = Array.from({ length: 101 }, (_, i) => rpc(i, 'tools/list'));
    const response = await postRpc(url, batch, bearer(TOKEN));
    expect(response.status).toBe(400);
    expect((response.json as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('rejects an unsupported protocol version header', async () => {
    const { url } = await start();
    const response = await postRpc(url, rpc(1, 'tools/list'), {
      ...bearer(TOKEN),
      'mcp-protocol-version': '1999-01-01',
    });
    expect(response.status).toBe(400);
    expect((response.json as { error: { code: number } }).error.code).toBe(-32000);
  });
});

describe('createMockDownstream: concurrency and lifecycle', () => {
  it('keeps 20 parallel calls isolated', async () => {
    const { mock, url } = await start();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postRpc(url, call(i, 'admin_reset_key', { key_id: `k-${i}` }), bearer(TOKEN)),
      ),
    );
    responses.forEach((response, i) => {
      const body = response.json as { id: number; result: { content: { text: string }[] } };
      expect(body.id).toBe(i);
      expect(JSON.parse(body.result.content[0]?.text ?? '')).toEqual({
        reset: true,
        key_id: `k-${i}`,
      });
    });
    expect(mock.calls).toHaveLength(20);
    const keyIds = mock.calls.map((entry) => (entry.arguments as { key_id: string }).key_id);
    expect(new Set(keyIds)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `k-${i}`)));
  });

  it('answers mixed parallel auth exactly', async () => {
    const { mock, url } = await start();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postRpc(url, call(i, 'get_status'), bearer(i % 2 === 0 ? TOKEN : 'wrong')),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10);
    expect(mock.calls).toHaveLength(10);
  });

  it('releases the port on close', async () => {
    const { mock, url } = await start();
    running.splice(running.indexOf(mock), 1);
    await mock.close();
    await expect(postRpc(url, rpc(1, 'tools/list'), bearer(TOKEN))).rejects.toThrow();
    const port = Number(new URL(url).port);
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(port, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it('closes promptly with an idle keep-alive connection open', async () => {
    const { mock, url } = await start();
    await postRpc(url, rpc(1, 'tools/list'), bearer(TOKEN));
    running.splice(running.indexOf(mock), 1);
    const startedAt = performance.now();
    await mock.close();
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('logs to the injected logger as JSON, without tokens', async () => {
    const sink = new CaptureSink();
    const { url } = await start({ sink });
    await postRpc(url, call(1, 'get_status'), bearer(TOKEN));
    await postRpc(url, call(2, 'get_status'), bearer('wrong'));
    expect(sink.lines().length).toBeGreaterThan(0);
    for (const line of sink.lines()) {
      expect(JSON.parse(line)).toMatchObject({ service: 'mock-downstream' });
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('wrong');
    }
  });
});

describe('createMockDownstream: streaming mode', () => {
  it('answers with an SSE stream when JSON responses are disabled', async () => {
    const { url } = await start({ jsonResponse: false });
    const response = await postRpc(url, call(1, 'get_status'), bearer(TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.text).toContain('"status');
    expect(response.text).toMatch(/^event: message/m);
  });
});

describe('createMockDownstream: raw request targets and headers', () => {
  // fetch normalizes request targets, so these go through http.request unmodified.
  function rawRequest(
    url: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const { port } = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(rpc(1, 'tools/list')));
    });
  }

  const mcpHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };

  it.each(['//evil/mcp', 'http://[/mcp', '/mcp/../mcp', '/%6dcp'])(
    'answers 404 (never 500) for the request target %s',
    async (path) => {
      const sink = new CaptureSink();
      const { mock, url } = await start({ sink });
      const response = await rawRequest(url, path, { ...mcpHeaders, ...bearer(TOKEN) });
      expect(response.status).toBe(404);
      expect(mock.calls).toEqual([]);
      expect(sink.chunks.join('')).not.toContain('"level":"error"');
    },
  );

  it('relies on Node trimming whitespace around the Authorization value', async () => {
    const { url } = await start();
    const response = await rawRequest(url, '/mcp', {
      ...mcpHeaders,
      authorization: `Bearer ${TOKEN}   `,
    });
    expect(response.status).toBe(200);
  });
});
