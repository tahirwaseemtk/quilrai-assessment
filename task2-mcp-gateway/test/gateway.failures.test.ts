import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RELAY_BYTES } from '../src/forward.js';
import { startCaptureDownstream, type CaptureDownstream } from './helpers/capture-downstream.js';
import {
  DOWNSTREAM_TOKEN,
  LIST,
  rpcErrorBody,
  startGateway,
  stdHeaders,
  stopGateways,
} from './helpers/gateway-harness.js';
import { rawRequest } from './helpers/raw-http.js';

let downstream: CaptureDownstream;

beforeEach(async () => {
  downstream = await startCaptureDownstream();
});

afterEach(async () => {
  await stopGateways();
  await downstream.close();
});

const INTERNAL = (id: unknown) => rpcErrorBody(id, -32603, 'Internal error');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (id: number) => `event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{}}\n\n`;

// Resolves to what the client saw: a complete response, or the error that cut it short.
async function observe(
  port: number,
  body: string,
): Promise<{ status?: number | undefined; text?: string; error?: string }> {
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
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        const finish = (error?: string) =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
            ...(error === undefined ? {} : { error }),
          });
        res.on('end', () => finish());
        res.on('error', (error) => finish(error.message));
        res.on('aborted', () => finish('aborted'));
      },
    );
    req.on('error', (error) => resolve({ error: error.message }));
    req.end(body);
  });
}

describe('downstream 5xx', () => {
  it.each([500, 502, 503, 504, 599])(
    'answers a downstream %i with a sanitized 502 and drops its JSON-RPC error body',
    async (status) => {
      downstream.respond((_req, res) => {
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end('{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"boom"}}');
      });
      const { port } = await startGateway({ downstreamUrl: downstream.url });
      const response = await rawRequest({
        port,
        headers: stdHeaders(),
        body: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
      });
      expect(response.status).toBe(502);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.text).toBe(INTERNAL(7));
    },
  );

  it('does not relay an HTML error page or its internals', async () => {
    downstream.respond((_req, res) => {
      res
        .writeHead(503, { 'content-type': 'text/html' })
        .end('<html>/srv/app/x 10.0.0.5 stack trace</html>');
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url });
    const response = await rawRequest({ port, headers: stdHeaders(), body: LIST });
    expect(response.status).toBe(502);
    expect(response.text).toBe(INTERNAL(1));
    expect(response.text).not.toMatch(/<html|\/srv|10\.0\.0\.5/);
  });

  it('leaks none of the downstream headers', async () => {
    downstream.respond((_req, res) => {
      res
        .writeHead(500, {
          'content-type': 'text/html',
          'set-cookie': 'a=b',
          'x-powered-by': 'x',
          server: 's',
          'www-authenticate': 'Basic',
          'retry-after': '9',
          'mcp-session-id': 's-1',
        })
        .end('oops');
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url });
    const response = await rawRequest({ port, headers: stdHeaders(), body: LIST });
    expect(response.status).toBe(502);
    for (const name of [
      'set-cookie',
      'x-powered-by',
      'server',
      'www-authenticate',
      'retry-after',
    ]) {
      expect(response.headers[name]).toBeUndefined();
    }
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  it.each([
    ['a number id', '{"jsonrpc":"2.0","id":7,"method":"tools/list"}', 7],
    ['a string id', '{"jsonrpc":"2.0","id":"abc","method":"tools/list"}', 'abc'],
    ['a notification', '{"jsonrpc":"2.0","method":"notifications/initialized"}', null],
  ])('echoes the id for %s', async (_label, body, id) => {
    downstream.respond((_req, res) => res.writeHead(503).end());
    const { port } = await startGateway({ downstreamUrl: downstream.url });
    const response = await rawRequest({ port, headers: stdHeaders(), body });
    expect(response.text).toBe(INTERNAL(id));
  });

  it('answers without waiting for a body that never ends', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(503);
      res.write('partial');
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, idleTimeoutMs: 30_000 });
    const started = Date.now();
    const response = await rawRequest({ port, headers: stdHeaders(), body: LIST });
    expect(response.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('writes the failure to the log without the body, the URL or the cookie', async () => {
    downstream.respond((_req, res) => {
      res
        .writeHead(500, { 'content-type': 'text/plain', 'set-cookie': 's=1' })
        .end('password=hunter2 /srv/x');
    });
    const { port, sink } = await startGateway({ downstreamUrl: downstream.url });
    await rawRequest({ port, headers: stdHeaders(), body: LIST });
    const text = sink.chunks.join('');
    expect(text).toContain('"downstream_status":500');
    for (const leak of ['hunter2', '/srv/x', '127.0.0.1', 'set-cookie', `${DOWNSTREAM_TOKEN}`]) {
      expect(text).not.toContain(leak);
    }
  });

  it('keeps serving other requests alongside and after a failure', async () => {
    downstream.respond((_req, res, captured) => {
      const { id } = JSON.parse(captured.body.toString()) as { id: number };
      if (id === 1) res.writeHead(500).end('x');
      else
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(`{"jsonrpc":"2.0","id":${id},"result":{}}`);
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url });
    const [failed, ok] = await Promise.all([
      rawRequest({
        port,
        headers: stdHeaders(),
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
      rawRequest({
        port,
        headers: stdHeaders(),
        body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      }),
    ]);
    expect(failed.text).toBe(INTERNAL(1));
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('{"jsonrpc":"2.0","id":2,"result":{}}');
  });
});

describe('idle timeout after headers', () => {
  it('ends a stalled stream with no body and never answers 502 after the 200', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    });
    const { port, sink } = await startGateway({
      downstreamUrl: downstream.url,
      idleTimeoutMs: 200,
    });
    const started = Date.now();
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(result.text ?? '').toBe('');
    expect(Date.now() - started).toBeLessThan(1500);
    await sleep(50);
    expect(sink.chunks.join('')).toContain('"reason":"idle"');
  });

  it('keeps an SSE stream alive while events keep arriving within the window', async () => {
    downstream.respond(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let id = 1; id <= 6; id++) {
        res.write(event(id));
        await sleep(80);
      }
      res.end();
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, idleTimeoutMs: 300 });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(result.text).toBe([1, 2, 3, 4, 5, 6].map(event).join(''));
  });

  it('cuts a stream whose gap is longer than the window', async () => {
    downstream.respond(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event(1));
      await sleep(600);
      res.write(event(2));
      res.end();
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, idleTimeoutMs: 200 });
    const result = await observe(port, LIST);
    expect(result.text).toBe(event(1));
  });

  it('does not apply the idle window before headers (the header timeout governs)', async () => {
    downstream.respond(async (_req, res) => {
      await sleep(300);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const { port } = await startGateway({
      downstreamUrl: downstream.url,
      idleTimeoutMs: 100,
      timeoutMs: 1000,
    });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(result.text).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
});

describe('size cap', () => {
  it('relays a chunked body of exactly the cap', async () => {
    const body = Buffer.alloc(1024, 0x61);
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(body.subarray(0, 512));
      res.end(body.subarray(512));
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, maxResponseBytes: 1024 });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.text ?? '')).toBe(1024);
  });

  it('refuses a declared length above the cap with a sanitized 502 before relaying', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1025' });
      res.end(Buffer.alloc(1025, 0x61));
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, maxResponseBytes: 1024 });
    const response = await rawRequest({ port, headers: stdHeaders(), body: LIST });
    expect(response.status).toBe(502);
    expect(response.text).toBe(INTERNAL(1));
  });

  it('cuts a chunked body one byte over the cap at exactly the cap', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 3; i++) res.write(Buffer.alloc(342, 0x61));
      res.end(Buffer.alloc(1, 0x61));
    });
    const { port } = await startGateway({ downstreamUrl: downstream.url, maxResponseBytes: 1024 });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.text ?? '')).toBeLessThanOrEqual(1024);
    expect(result.error ?? 'ended').not.toBe('ended');
  });

  it('cuts a trickle at the cap, well before the idle window would', async () => {
    downstream.respond(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 400 && !res.destroyed; i++) {
        res.write('a');
        await sleep(20);
      }
      res.end();
    });
    const { port } = await startGateway({
      downstreamUrl: downstream.url,
      maxResponseBytes: 100,
      idleTimeoutMs: 5000,
    });
    const started = Date.now();
    const result = await observe(port, LIST);
    // Ended by the cap, not by the 5 s idle window.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Buffer.byteLength(result.text ?? '')).toBeLessThanOrEqual(100);
  });

  it('keeps the production cap at 4 MiB', () => {
    expect(MAX_RELAY_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('logged reasons after headers', () => {
  it('logs too-large when the cap cuts a chunked body', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(Buffer.alloc(600, 0x61));
      res.end(Buffer.alloc(600, 0x61));
    });
    const { port, sink } = await startGateway({
      downstreamUrl: downstream.url,
      maxResponseBytes: 1024,
    });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(sink.chunks.join('')).toContain('"reason":"too-large"');
  });

  it('ends the client stream and logs downstream when the downstream dies after headers', async () => {
    downstream.respond((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event(1));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const { port, sink } = await startGateway({ downstreamUrl: downstream.url });
    const result = await observe(port, LIST);
    expect(result.status).toBe(200);
    expect(result.status).not.toBe(502);
    expect(result.text).toBe(event(1));
    await sleep(50);
    expect(sink.chunks.join('')).toMatch(/"reason":"downstream"/);
  });
});
