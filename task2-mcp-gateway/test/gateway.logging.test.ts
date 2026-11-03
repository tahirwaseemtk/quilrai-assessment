import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startCaptureDownstream, type CaptureDownstream } from './helpers/capture-downstream.js';
import {
  ADMIN_TOKEN,
  DOWNSTREAM_TOKEN,
  LIST,
  startGateway,
  stdHeaders,
  stopGateways,
} from './helpers/gateway-harness.js';
import { rawRequest } from './helpers/raw-http.js';

let downstream: CaptureDownstream | undefined;

afterEach(async () => {
  await stopGateways();
  await downstream?.close();
});

const UNKNOWN = 'unknown-token-123456';
const MARKER = 'BODY-MARKER-123';

async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

const parse = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('request logging', () => {
  it('logs one line per request with no secrets, headers or body', async () => {
    downstream = await startCaptureDownstream();
    const { port, sink } = await startGateway({ downstreamUrl: downstream.url });
    const marked = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"m":"${MARKER}"}}`;
    const statuses = [
      await rawRequest({ port, headers: stdHeaders({}, ADMIN_TOKEN), body: marked }),
      await rawRequest({ port, headers: stdHeaders({}, UNKNOWN), body: marked }),
      await rawRequest({
        port,
        headers: stdHeaders({ 'content-type': 'text/plain' }),
        body: marked,
      }),
      await rawRequest({ port, headers: stdHeaders({ 'content-length': 2_000_000 }) }),
      await rawRequest({ port, headers: stdHeaders(), body: `{${MARKER}` }),
      await rawRequest({
        port,
        headers: stdHeaders(),
        body: `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"${MARKER}"}}`,
      }),
    ].map((response) => response.status);
    expect(statuses).toEqual([200, 401, 415, 413, 400, 202]);

    const text = sink.chunks.join('');
    for (const secret of [ADMIN_TOKEN, UNKNOWN, DOWNSTREAM_TOKEN, MARKER]) {
      expect(text).not.toContain(secret);
    }
    const lines = parse(sink.lines()).filter((line) => line.msg === 'request');
    expect(lines.map((line) => line.status)).toEqual(statuses);
    for (const line of lines) {
      expect(line.http_method).toBe('POST');
      expect(typeof line.duration_ms).toBe('number');
      expect(line.duration_ms as number).toBeGreaterThanOrEqual(0);
      for (const key of ['headers', 'body', 'authorization', 'url']) {
        expect(Object.hasOwn(line, key)).toBe(false);
      }
    }
    expect(lines[0]?.rpc_method).toBe('tools/list');
    expect(Object.hasOwn(lines[1] ?? {}, 'rpc_method')).toBe(false);
  });

  it('logs a downstream failure as an error code only, and keeps the client body sanitized', async () => {
    const { port, sink } = await startGateway({ downstreamUrl: await closedPortUrl() });
    const response = await rawRequest({ port, headers: stdHeaders(), body: LIST });
    expect(response.status).toBe(502);
    const lines = parse(sink.lines());
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toEqual([
      expect.objectContaining({ msg: 'downstream request failed', error_code: 'ECONNREFUSED' }),
    ]);
    expect(sink.chunks.join('')).not.toMatch(/127\.0\.0\.1|\/mcp/);
    expect(lines.find((line) => line.msg === 'request')).toMatchObject({ status: 502 });
  });

  it('logs a client that leaves before the response as 499', async () => {
    downstream = await startCaptureDownstream();
    downstream.respond(() => undefined);
    const { port, sink } = await startGateway({ downstreamUrl: downstream.url });
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: stdHeaders(),
        agent: false,
      });
      req.on('error', () => undefined);
      req.on('close', () => resolve());
      setTimeout(() => req.destroy(), 50);
      req.end(LIST);
    });
    for (let attempt = 0; attempt < 40 && sink.lines().length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(parse(sink.lines()).find((line) => line.msg === 'request')).toMatchObject({
      status: 499,
    });
  });
});
