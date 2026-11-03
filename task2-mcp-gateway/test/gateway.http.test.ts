import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../src/read-body.js';
import { startCaptureDownstream, type CaptureDownstream } from './helpers/capture-downstream.js';
import {
  ADMIN_TOKEN,
  LIST,
  rpcErrorBody,
  startGateway,
  stdHeaders,
  stopGateways,
  VIEWER_TOKEN,
} from './helpers/gateway-harness.js';
import { rawRequest, rawSocketRequest } from './helpers/raw-http.js';

let downstream: CaptureDownstream;
let port: number;

beforeEach(async () => {
  downstream = await startCaptureDownstream();
  ({ port } = await startGateway({ downstreamUrl: downstream.url }));
});

afterEach(async () => {
  await stopGateways();
  await downstream.close();
});

const post = (body: Buffer | string, headers = stdHeaders()) => rawRequest({ port, headers, body });

// Pads LIST with trailing whitespace (valid JSON) to an exact byte length.
const padded = (length: number, prefix = Buffer.alloc(0)): Buffer =>
  Buffer.concat([
    prefix,
    Buffer.from(LIST),
    Buffer.alloc(length - prefix.length - LIST.length, 0x20),
  ]);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PARSE_ERROR = rpcErrorBody(null, -32700, 'Parse error');

describe('listen and close', () => {
  it('binds a port, reports the /mcp URL and refuses connections after close', async () => {
    const started = await startGateway({ downstreamUrl: downstream.url });
    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}/mcp`);
    await started.gateway.close();
    await expect(rawRequest({ port: started.port, method: 'GET' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});

describe('routing', () => {
  it.each(['/', '/mcp/', '/MCP', '//mcp', '/mcp/x', 'http://127.0.0.1/mcp', 'http://[/mcp', '*'])(
    'answers 404 for the request-target %j without auth',
    async (target) => {
      const response = await rawSocketRequest(
        port,
        `POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      expect(response).toMatch(/^HTTP\/1\.1 404 /);
      expect(response.endsWith('\r\n\r\nNot Found')).toBe(true);
      expect(downstream.requests).toHaveLength(0);
    },
  );

  it('accepts /mcp with a query and never forwards the query', async () => {
    const response = await rawRequest({
      port,
      path: '/mcp?x=1',
      headers: stdHeaders(),
      body: LIST,
    });
    expect(response.status).toBe(200);
    expect(downstream.requests.map((request) => request.path)).toEqual(['/mcp']);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('answers 405 to %s', async (method) => {
    const response = await rawRequest({ port, method });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(response.text).toBe('Method Not Allowed');
  });

  it('answers 405 to HEAD with an empty body', async () => {
    const response = await rawRequest({ port, method: 'HEAD' });
    expect(response.status).toBe(405);
    expect(response.text).toBe('');
  });

  it('checks path, method, auth, content type and size in that order', async () => {
    const big = { 'content-length': 2_000_000 };
    const statuses = [
      await rawRequest({ port, method: 'GET', path: '/x' }),
      await rawRequest({ port, method: 'GET' }),
      await rawRequest({ port, headers: { 'content-type': 'text/plain', ...big } }),
      await rawRequest({ port, headers: stdHeaders({ 'content-type': 'text/plain', ...big }) }),
      await rawRequest({ port, headers: stdHeaders(big) }),
    ].map((response) => response.status);
    expect(statuses).toEqual([404, 405, 401, 415, 413]);
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['Basic', 'Basic dXNlcjpwYXNz'],
    ['a bare scheme', 'Bearer'],
    ['two spaces', `Bearer  ${VIEWER_TOKEN}`],
    ['an unknown token', 'Bearer unknown-token-123456'],
    ['another scheme', `Token ${VIEWER_TOKEN}`],
    ['two equal headers', [`Bearer ${VIEWER_TOKEN}`, `Bearer ${VIEWER_TOKEN}`]],
    ['a valid and an unknown header', [`Bearer ${VIEWER_TOKEN}`, 'Bearer unknown-token-123456']],
  ])('answers 401 identically for %s', async (_label, authorization) => {
    const headers = stdHeaders();
    delete headers.authorization;
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await post(LIST, headers);
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.text).toBe('Unauthorized');
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([
    `Bearer ${VIEWER_TOKEN}`,
    `Bearer ${ADMIN_TOKEN}`,
    `bearer ${VIEWER_TOKEN}`,
    `BEARER ${ADMIN_TOKEN}`,
  ])('forwards for %s', async (authorization) => {
    const response = await post(LIST, stdHeaders({ authorization }));
    expect(response.status).toBe(200);
    expect(downstream.requests).toHaveLength(1);
  });
});

describe('content type', () => {
  it.each([
    undefined,
    'text/plain',
    'application/jsonx',
    'application/json-patch+json',
    'application/*',
    'multipart/form-data',
    'application/json; charset=latin1',
    'application/json; charset=utf-16',
    'application/json; foo=bar',
    'application/json; charset=utf-8; charset=latin1',
    'application/json; charset',
    ['application/json', 'application/json'],
  ])('answers 415 to %j', async (contentType) => {
    const headers = stdHeaders();
    delete headers['content-type'];
    if (contentType !== undefined) headers['content-type'] = contentType;
    const response = await post(LIST, headers);
    expect(response.status).toBe(415);
    expect(response.text).toBe('Unsupported Media Type');
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([
    'application/json',
    'Application/JSON',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json ; charset=utf-8',
    'application/json; charset="utf-8"',
    'application/json;',
  ])('forwards %j with the gateway content type', async (contentType) => {
    const response = await post(LIST, stdHeaders({ 'content-type': contentType }));
    expect(response.status).toBe(200);
    expect(downstream.requests[0]?.headers['content-type']).toBe('application/json');
  });
});

describe('body size', () => {
  it('forwards a body of exactly the limit (Content-Length)', async () => {
    const body = padded(MAX_BODY_BYTES);
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(downstream.requests[0]?.body.equals(body)).toBe(true);
  });

  it('answers 413 one byte over the limit (Content-Length)', async () => {
    const response = await post(padded(MAX_BODY_BYTES + 1));
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(response.text).toBe('Payload Too Large');
    expect(downstream.requests).toHaveLength(0);
  });

  it('answers 413 from the Content-Length header before any body byte is sent', async () => {
    const started = Date.now();
    const response = await rawRequest({
      port,
      headers: stdHeaders({ 'content-length': 2_000_000 }),
    });
    expect(response.status).toBe(413);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  const chunked = (body: Buffer, size = 64 * 1024): Buffer[] => {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < body.length; offset += size) {
      chunks.push(body.subarray(offset, offset + size));
    }
    return chunks;
  };

  it('forwards a chunked body of exactly the limit', async () => {
    const body = padded(MAX_BODY_BYTES);
    const response = await rawRequest({ port, headers: stdHeaders(), chunks: chunked(body) });
    expect(response.status).toBe(200);
    expect(downstream.requests[0]?.body.equals(body)).toBe(true);
  });

  it('answers 413 to a chunked body one byte over the limit', async () => {
    const response = await rawRequest({
      port,
      headers: stdHeaders(),
      chunks: chunked(padded(MAX_BODY_BYTES + 1)),
    });
    expect(response.status).toBe(413);
    expect(downstream.requests).toHaveLength(0);
  });

  it('stops reading an oversized chunked body and keeps serving', async () => {
    const response = await rawRequest({
      port,
      headers: stdHeaders(),
      chunks: chunked(Buffer.alloc(10 * 1024 * 1024, 0x20)),
    });
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(downstream.requests).toHaveLength(0);
    expect((await post(LIST)).status).toBe(200);
  });

  it('counts a BOM toward the limit', async () => {
    const response = await post(padded(MAX_BODY_BYTES + 1, BOM));
    expect(response.status).toBe(413);
  });
});

describe('session header', () => {
  it('answers 400 to more than one Mcp-Session-Id header', async () => {
    const response = await post(LIST, stdHeaders({ 'mcp-session-id': ['a', 'b'] }));
    expect(response.status).toBe(400);
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('UTF-8 decoding', () => {
  const inString = (bytes: number[]): Buffer =>
    Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":"'),
      Buffer.from(bytes),
      Buffer.from('"}}'),
    ]);

  it.each([
    ['0xFF', inString([0xff])],
    ['an overlong slash', inString([0xc0, 0xaf])],
    ['an overlong three-byte form', inString([0xe0, 0x80, 0xaf])],
    ['a lone surrogate', inString([0xed, 0xa0, 0x80])],
    ['a code point above U+10FFFF', inString([0xf4, 0x90, 0x80, 0x80])],
    ['a five-byte form', inString([0xf8, 0x88, 0x80, 0x80, 0x80])],
    ['a bare continuation byte', inString([0x80])],
    [
      'a truncated sequence at the end',
      Buffer.concat([Buffer.from(LIST), Buffer.from([0xe2, 0x82])]),
    ],
  ])('answers -32700 to %s', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.text).toBe(PARSE_ERROR);
    expect(downstream.requests).toHaveLength(0);
  });

  const multibyte = Buffer.from(
    `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"s":"${String.fromCodePoint(0xe9, 0x20ac, 0x1f600)}"}}`,
  );

  it('forwards multibyte characters split at every byte offset unchanged', async () => {
    for (let offset = 1; offset < multibyte.length; offset++) {
      const response = await rawRequest({
        port,
        headers: stdHeaders(),
        chunks: [multibyte.subarray(0, offset), multibyte.subarray(offset)],
      });
      expect(response.status).toBe(200);
    }
    expect(downstream.requests).toHaveLength(multibyte.length - 1);
    for (const request of downstream.requests) expect(request.body.equals(multibyte)).toBe(true);
  });

  it('strips one leading BOM before forwarding', async () => {
    const response = await post(Buffer.concat([BOM, Buffer.from(LIST)]));
    expect(response.status).toBe(200);
    expect(downstream.requests[0]?.body.equals(Buffer.from(LIST))).toBe(true);
  });

  it.each([
    ['two BOMs', Buffer.concat([BOM, BOM, Buffer.from(LIST)])],
    ['a BOM after a space', Buffer.concat([Buffer.from(' '), BOM, Buffer.from(LIST)])],
    ['a UTF-16 BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(LIST)])],
  ])('answers -32700 to %s', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.text).toBe(PARSE_ERROR);
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('classification status codes', () => {
  it.each(['{', '', 'abc'])('answers -32700 with HTTP 400 to %j', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.text).toBe(PARSE_ERROR);
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([
    [`[${LIST}]`, null],
    ['[]', null],
    ['{"jsonrpc":"1.0","id":5,"method":"x"}', 5],
    ['{"jsonrpc":"2.0","id":6,"method":"Tools/Call","params":{"name":"get_status"}}', 6],
    ['{"jsonrpc":"2.0","method":"a","method":"b"}', null],
    ['{"jsonrpc":"2.0","id":1,"result":{},"result":{}}', null],
  ])('answers -32600 with HTTP 400 to %s', async (body, id) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.text).toBe(rpcErrorBody(id, -32600, 'Invalid Request'));
    expect(downstream.requests).toHaveLength(0);
  });

  it.each([{}, { name: 1 }, { name: 'x', arguments: [] }])(
    'answers -32602 with HTTP 200 to tools/call params %j',
    async (params) => {
      const response = await post(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params }),
      );
      expect(response.status).toBe(200);
      expect(response.text).toBe(rpcErrorBody(3, -32602, 'Invalid params'));
      expect(downstream.requests).toHaveLength(0);
    },
  );

  it.each([
    '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"admin"}}',
    '{"jsonrpc":"2.0","method":"x","params":[]}',
    '{"jsonrpc":"2.0","id":1,"result":5}',
  ])('answers 202 with no body to %s', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(202);
    expect(response.text).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('lingering close', () => {
  it('closes an unauthenticated endless chunked upload shortly after the 401', async () => {
    const { closedAfter, status } = await new Promise<{ closedAfter: number; status: number }>(
      (resolve) => {
        const started = Date.now();
        let status = 0;
        const req = http.request(
          { host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false },
          (res) => {
            status = res.statusCode ?? 0;
            res.resume();
          },
        );
        req.setHeader('content-type', 'application/json');
        const timer = setInterval(() => req.write(Buffer.alloc(16 * 1024, 0x20)), 5);
        req.on('error', () => undefined);
        req.on('close', () => {
          clearInterval(timer);
          resolve({ closedAfter: Date.now() - started, status });
        });
      },
    );
    expect(status).toBe(401);
    expect(closedAfter).toBeLessThan(1800);
  });
});

describe('single-value headers', () => {
  it('answers 400 to more than one MCP-Protocol-Version header', async () => {
    const response = await post(
      LIST,
      stdHeaders({ 'mcp-protocol-version': ['2025-06-18', '2024-11-05'] }),
    );
    expect(response.status).toBe(400);
    expect(downstream.requests).toHaveLength(0);
  });
});

describe('later check order', () => {
  const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);

  it('checks repeated headers before reading the body, and the size before decoding', async () => {
    const repeated = await post(invalidUtf8, stdHeaders({ 'mcp-session-id': ['a', 'b'] }));
    expect(repeated.status).toBe(400);
    expect(repeated.text).toBe('Bad Request');

    const oversized = await rawRequest({
      port,
      headers: stdHeaders(),
      chunks: [invalidUtf8, Buffer.alloc(MAX_BODY_BYTES, 0x20)],
    });
    expect(oversized.status).toBe(413);
    expect(downstream.requests).toHaveLength(0);
  });
});
