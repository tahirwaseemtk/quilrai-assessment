import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCaptureDownstream, type CaptureDownstream } from './helpers/capture-downstream.js';
import {
  DOWNSTREAM_TOKEN,
  LIST,
  rpcErrorBody,
  startGateway,
  stdHeaders,
  stopGateways,
  VIEWER_TOKEN,
} from './helpers/gateway-harness.js';
import { ACCEPT_MCP } from './helpers/mcp-http.js';
import { rawRequest } from './helpers/raw-http.js';

let downstream: CaptureDownstream;

beforeEach(async () => {
  downstream = await startCaptureDownstream();
});

afterEach(async () => {
  await stopGateways();
  await downstream.close();
});

async function gatewayPort(options: { timeoutMs?: number; downstreamUrl?: string } = {}) {
  const { port } = await startGateway({ downstreamUrl: downstream.url, ...options });
  return port;
}

const post = (port: number, body: Buffer | string, headers = stdHeaders()) =>
  rawRequest({ port, headers, body });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

const SSE = { 'content-type': 'text/event-stream' };
const event = (id: number) => `event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{}}\n\n`;
const INTERNAL = (id: unknown) => rpcErrorBody(id, -32603, 'Internal error');
const LEAK = /ECONNREFUSED|fetch failed|127\.0\.0\.1|:\d{2,5}|\bat \S+:\d+|mcp|stack/i;

describe('request forwarding', () => {
  it.each([
    LIST,
    '  {\n "method" : "tools/list",\t"id":1 , "jsonrpc":"2.0" }  ',
    '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"s":"\\u0041\\n"}}',
    '{"jsonrpc":"2.0","id":"a","method":"x","params":{"n":12345678901234567890,"f":1.0}}',
  ])('forwards %s byte for byte to the configured path', async (body) => {
    const port = await gatewayPort();
    const response = await rawRequest({ port, path: '/mcp?q=1', headers: stdHeaders(), body });
    expect(response.status).toBe(200);
    expect(downstream.requests).toHaveLength(1);
    expect(downstream.requests[0]?.body.equals(Buffer.from(body))).toBe(true);
    expect(downstream.requests[0]?.path).toBe('/mcp');
    expect(downstream.requests[0]?.method).toBe('POST');
  });

  it.each([
    [
      'initialize',
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}',
    ],
    ['ping', '{"jsonrpc":"2.0","id":2,"method":"ping"}'],
    ['an unknown method', '{"jsonrpc":"2.0","id":3,"method":"foo/bar"}'],
    ['a notification', '{"jsonrpc":"2.0","method":"notifications/initialized"}'],
    ['a client response', '{"jsonrpc":"2.0","id":9,"result":{}}'],
    [
      'a viewer tools/call of get_status',
      '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_status"}}',
    ],
  ])('forwards %s', async (_label, body) => {
    const port = await gatewayPort();
    downstream.respond((_req, res) => res.writeHead(202).end());
    const response = await post(port, body);
    expect(response.status).toBe(202);
    expect(downstream.requests).toHaveLength(1);
    expect(downstream.requests[0]?.body.equals(Buffer.from(body))).toBe(true);
  });

  it('sends only allowlisted headers and the gateway credential', async () => {
    const port = await gatewayPort();
    await post(
      port,
      LIST,
      stdHeaders({
        cookie: 's=1',
        'x-forwarded-for': '1.2.3.4',
        'proxy-authorization': 'Basic eA==',
        'x-api-key': 'k',
        'accept-encoding': 'br',
        'mcp-session-id': 'sess-1',
        'mcp-protocol-version': '2025-06-18',
        'content-type': 'application/json; charset=UTF-8',
      }),
    );
    const [request] = downstream.requests;
    if (!request) throw new Error('nothing forwarded');
    const names = request.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map((name) => name.toLowerCase());
    expect(names.filter((name) => name === 'authorization')).toHaveLength(1);
    expect(request.headers.authorization).toBe(`Bearer ${DOWNSTREAM_TOKEN}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers.accept).toBe(ACCEPT_MCP);
    expect(request.headers['mcp-session-id']).toBe('sess-1');
    expect(request.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(request.headers['accept-encoding']).not.toBe('br');
    const allowed = new Set([
      'host',
      'connection',
      'content-type',
      'content-length',
      'authorization',
      'accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'user-agent',
      'accept-encoding',
      'accept-language',
      'sec-fetch-mode',
    ]);
    expect(names.filter((name) => !allowed.has(name))).toEqual([]);
    expect(request.rawHeaders.join('\n')).not.toContain(VIEWER_TOKEN);
    expect(request.body.toString()).not.toContain(VIEWER_TOKEN);
  });

  it('omits Accept when the client sends none', async () => {
    const port = await gatewayPort();
    const headers = stdHeaders();
    delete headers.accept;
    await post(port, LIST, headers);
    // undici adds its own default ("*/*") when none is given; the client's absence is preserved.
    expect(downstream.requests[0]?.headers.accept).not.toBe(ACCEPT_MCP);
  });
});

describe('response relay', () => {
  it('relays status, content type, session id and body, and nothing else', async () => {
    const port = await gatewayPort();
    const body = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    downstream.respond((_req, res) => {
      res
        .writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'mcp-session-id': 's-1',
          'set-cookie': 'a=b',
          'x-powered-by': 'x',
          'www-authenticate': 'Basic',
        })
        .end(body);
    });
    const response = await post(port, LIST);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['mcp-session-id']).toBe('s-1');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.text).toBe(body);
  });

  it.each([
    [202, undefined, ''],
    [400, 'application/json', '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"x"}}'],
    [404, 'text/plain', 'Not Found'],
    [406, 'application/json', '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"x"}}'],
  ])('relays a downstream %i', async (status, contentType, body) => {
    const port = await gatewayPort();
    downstream.respond((_req, res) => {
      res
        .writeHead(status, contentType === undefined ? {} : { 'content-type': contentType })
        .end(body);
    });
    const response = await post(port, LIST);
    expect(response.status).toBe(status);
    expect(response.text).toBe(body);
  });

  it.each([401, 403])(
    'answers a downstream %i (its credential refused) with a sanitized 502',
    async (status) => {
      const port = await gatewayPort();
      downstream.respond((_req, res) => {
        res.writeHead(status, { 'www-authenticate': 'Bearer realm="internal"' }).end('denied');
      });
      const response = await post(port, LIST);
      expect(response.status).toBe(502);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.text).toBe(INTERNAL(1));
    },
  );
});

describe('streaming', () => {
  it('streams SSE events as they arrive instead of buffering', async () => {
    const port = await gatewayPort();
    const release = deferred();
    downstream.respond(async (_req, res) => {
      res.writeHead(200, SSE);
      res.write(event(1));
      await release.promise;
      res.end(event(2));
    });
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: stdHeaders() as Record<string, string>,
      body: LIST,
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    if (!response.body) throw new Error('no response body');
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(event(1));
    release.resolve();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toBe(event(2));
  });

  it('times out waiting for headers with a sanitized 502 and aborts the downstream call', async () => {
    const port = await gatewayPort({ timeoutMs: 100 });
    const aborted = deferred();
    downstream.respond((_req, res) => {
      res.on('close', () => {
        if (!res.writableFinished) aborted.resolve();
      });
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(200, SSE).end(event(7));
      }, 400);
    });
    const started = Date.now();
    const response = await post(port, '{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
    const elapsed = Date.now() - started;
    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.text).toBe(INTERNAL(7));
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(350);
    await aborted.promise;
  });

  it('does not cut a stream that outlives the header timeout', async () => {
    const port = await gatewayPort({ timeoutMs: 100 });
    let cut = false;
    downstream.respond(async (_req, res) => {
      res.on('close', () => (cut = !res.writableFinished));
      res.writeHead(200, SSE);
      for (let id = 1; id <= 6; id++) {
        res.write(event(id));
        await sleep(100);
      }
      res.end();
    });
    const response = await post(port, LIST);
    expect(response.status).toBe(200);
    expect(response.text).toBe([1, 2, 3, 4, 5, 6].map(event).join(''));
    expect(cut).toBe(false);
  });
});

it('relays SSE headers before the first event arrives', async () => {
  const port = await gatewayPort();
  const release = deferred();
  downstream.respond(async (_req, res) => {
    res.writeHead(200, SSE);
    res.flushHeaders();
    await release.promise;
    res.end(event(1));
  });
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: stdHeaders() as Record<string, string>,
    body: LIST,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  release.resolve();
  expect(await response.text()).toBe(event(1));
});

describe('downstream failures', () => {
  it.each([
    ['a closed port', 'closed'],
    ['a socket destroyed before headers', 'destroy'],
    ['an invalid status line', 'garbage'],
  ] as const)('answers %s with a sanitized 502', async (_label, mode) => {
    const downstreamUrl = mode === 'closed' ? await closedPortUrl() : downstream.url;
    const port = await gatewayPort({ downstreamUrl });
    downstream.respond((_req, res) => {
      if (mode === 'destroy') res.socket?.destroy();
      else res.socket?.end('HTTP/1.1 abc\r\n\r\n');
    });
    const response = await post(port, LIST);
    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.text).toBe(INTERNAL(1));
    expect(response.text.replace('Internal error', '')).not.toMatch(LEAK);
  });

  it.each([
    ['{"jsonrpc":"2.0","id":7,"method":"tools/list"}', 7],
    ['{"jsonrpc":"2.0","id":"abc","method":"tools/list"}', 'abc'],
    ['{"jsonrpc":"2.0","id":0,"method":"tools/list"}', 0],
    ['{"jsonrpc":"2.0","method":"notifications/initialized"}', null],
    ['{"jsonrpc":"2.0","id":9,"result":{}}', null],
  ])('echoes the request id in a 502 for %s', async (body, id) => {
    const port = await gatewayPort({ downstreamUrl: await closedPortUrl() });
    const response = await post(port, body);
    expect(response.status).toBe(502);
    expect(response.text).toBe(INTERNAL(id));
  });

  it('ends the client response when the downstream fails mid-stream, and keeps serving', async () => {
    const port = await gatewayPort();
    downstream.respond((_req, res) => {
      res.writeHead(200, SSE);
      res.write('event: message\ndata: {"jso', () => res.socket?.destroy());
    });
    const outcome = await post(port, LIST).then(
      () => 'ended',
      () => 'errored',
    );
    expect(['ended', 'errored']).toContain(outcome);
    downstream.respond((_req, res) => res.writeHead(200).end('{}'));
    expect((await post(port, LIST)).status).toBe(200);
  });
});

describe('client disconnects', () => {
  function abortingRequest(port: number, when: 'first-data' | number): Promise<void> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: stdHeaders(),
          agent: false,
        },
        (res) => res.once('data', () => when === 'first-data' && req.destroy()),
      );
      req.on('error', () => undefined);
      req.on('close', () => resolve());
      if (typeof when === 'number') setTimeout(() => req.destroy(), when);
      req.end(LIST);
    });
  }

  it('aborts the downstream stream when the client leaves after headers', async () => {
    const port = await gatewayPort();
    const closed = deferred();
    downstream.respond((_req, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200, SSE);
      res.write(event(1));
    });
    await abortingRequest(port, 'first-data');
    const started = Date.now();
    await closed.promise;
    expect(Date.now() - started).toBeLessThan(1000);
    downstream.respond((_req, res) => res.writeHead(200).end('{}'));
    expect((await post(port, LIST)).status).toBe(200);
  });

  it('aborts the downstream call when the client leaves before headers', async () => {
    const port = await gatewayPort();
    let closedAt = 0;
    const closed = deferred();
    downstream.respond((_req, res) => {
      res.on('close', () => {
        closedAt = Date.now();
        closed.resolve();
      });
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(200).end('{}');
      }, 2000);
    });
    const started = Date.now();
    await abortingRequest(port, 50);
    await closed.promise;
    expect(closedAt - started).toBeLessThan(500);
  });
});

describe('concurrency', () => {
  it('keeps parallel requests and responses paired', async () => {
    const port = await gatewayPort();
    downstream.respond(async (_req, res, captured) => {
      const { id } = JSON.parse(captured.body.toString()) as { id: number };
      await sleep(Math.floor(Math.random() * 50));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    });
    const ids = Array.from({ length: 10 }, (_, index) => index + 1);
    const responses = await Promise.all(
      ids.map((id) => post(port, JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }))),
    );
    expect(responses.map((response) => (JSON.parse(response.text) as { id: number }).id)).toEqual(
      ids,
    );
    expect(downstream.requests).toHaveLength(10);
  });
});
