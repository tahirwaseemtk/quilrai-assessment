import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { createHttpProvider, MAX_PROVIDER_BYTES } from '../src/providers.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
  );
});

// A one-shot upstream whose reply the test controls.
async function upstream(handler: (res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1/completions`;
}

function provider(url: string, timeoutMs = 2000) {
  const sink = new CaptureSink();
  return {
    sink,
    client: createHttpProvider({
      name: 'test',
      url,
      apiKey: 'provider-secret-0123456789',
      timeoutMs,
      logger: createLogger({ service: 'task4-rate-limit-router', sink }),
    }),
  };
}

describe('provider outcomes', () => {
  it('serves a 200 with its body and the reported total tokens', async () => {
    const body = '{"usage":{"total_tokens":42},"choices":[]}';
    const url = await upstream((res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(body),
    );
    expect(await provider(url).client.complete('{}')).toEqual({
      kind: 'ok',
      body,
      totalTokens: 42,
    });
  });

  it('serves a 200 without usage, leaving the total to the estimate', async () => {
    const url = await upstream((res) => res.writeHead(200).end('{"choices":[]}'));
    expect(await provider(url).client.complete('{}')).toEqual({
      kind: 'ok',
      body: '{"choices":[]}',
    });
  });

  it.each([429, 500, 502, 503])('treats %i as retryable', async (status) => {
    const url = await upstream((res) => res.writeHead(status).end('internal detail'));
    expect((await provider(url).client.complete('{}')).kind).toBe('retryable');
  });

  it.each([400, 401, 403, 404, 422])(
    'treats %i as a rejection, not a failover case',
    async (status) => {
      const url = await upstream((res) => res.writeHead(status).end('bad'));
      expect(await provider(url).client.complete('{}')).toEqual({ kind: 'rejected', status });
    },
  );

  it('treats a 200 with a body that is not JSON as retryable', async () => {
    const url = await upstream((res) => res.writeHead(200).end('<html>oops</html>'));
    expect((await provider(url).client.complete('{}')).kind).toBe('retryable');
  });

  it('ignores a late answer: the call settles as a timeout, never as ok', async () => {
    const url = await upstream((res) => {
      setTimeout(() => res.writeHead(200).end('{"choices":[],"usage":{"total_tokens":1}}'), 400);
    });
    const outcome = await provider(url, 150).client.complete('{}');
    expect(outcome).toEqual({ kind: 'retryable', reason: 'timeout' });
  });

  it('refuses a provider body larger than the cap, as retryable', async () => {
    const url = await upstream((res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_PROVIDER_BYTES + 1, 0x20));
    });
    expect(await provider(url).client.complete('{}')).toEqual({
      kind: 'retryable',
      reason: 'body too large',
    });
  });

  it('times out a provider that never answers, close to the deadline', async () => {
    const url = await upstream(() => undefined);
    const started = Date.now();
    const outcome = await provider(url, 150).client.complete('{}');
    expect(outcome).toEqual({ kind: 'retryable', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('treats a refused connection as retryable', async () => {
    const outcome = await provider('http://127.0.0.1:9/v1/completions').client.complete('{}');
    expect(outcome).toEqual({ kind: 'retryable', reason: 'network' });
  });

  it('never logs the provider key, the upstream body or the URL', async () => {
    const url = await upstream((res) => res.writeHead(500).end('secret upstream body'));
    const { client, sink } = provider(url);
    await client.complete('{"prompt":"private"}');
    const logged = sink.chunks.join('');
    expect(logged).not.toContain('provider-secret');
    expect(logged).not.toContain('secret upstream body');
    expect(logged).not.toContain('127.0.0.1');
  });
});
