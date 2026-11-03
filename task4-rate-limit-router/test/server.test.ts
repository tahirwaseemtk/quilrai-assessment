import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { createStubProvider, type StubProvider } from '../stub-providers/server.js';
import { openDatabase } from '../src/db.js';
import { parseRouterConfig } from '../src/config.js';
import { createLimiter } from '../src/limiter.js';
import { createHttpProvider } from '../src/providers.js';
import { createRouterServer, type RouterServer } from '../src/server.js';

const CLIENT_KEY = 'client-key-0123456789abcdef';
const PROVIDER_KEY = 'provider-key-0123456789abcdef';
const running: Array<RouterServer | StubProvider> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.close()));
});

async function start(options: { limit?: number; primaryTimeoutMs?: number } = {}) {
  const primary = createStubProvider();
  const secondary = createStubProvider();
  running.push(primary, secondary);
  const primaryAt = await primary.listen();
  const secondaryAt = await secondary.listen();
  const sink = new CaptureSink();
  const db = openDatabase(':memory:');
  const logger = createLogger({ service: 'task4-rate-limit-router', sink });
  const server = createRouterServer({
    limiter: createLimiter({
      db,
      clock: { now: () => Date.now() },
      limit: options.limit ?? 1000,
      windowMs: 60_000,
      reservationTtlMs: 60_000,
    }),
    primary: createHttpProvider({
      name: 'primary',
      url: primaryAt.url,
      apiKey: PROVIDER_KEY,
      timeoutMs: options.primaryTimeoutMs ?? 2000,
      logger,
    }),
    secondary: createHttpProvider({
      name: 'secondary',
      url: secondaryAt.url,
      apiKey: PROVIDER_KEY,
      timeoutMs: 2000,
      logger,
    }),
    logger,
  });
  running.push(server);
  const { url } = await server.listen();
  return { url, primary, secondary, sink };
}

async function call(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CLIENT_KEY}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { prompt: 'hello there', max_tokens: 10 };

describe('success', () => {
  it('returns the provider answer with a request id', async () => {
    const { url } = await start();
    const response = await call(url, VALID);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(((await response.json()) as { choices: { text: string }[] }).choices[0]?.text).toBe(
      'stub answer',
    );
  });

  it('sends the provider key, never the client key', async () => {
    const { url, primary } = await start();
    await call(url, VALID);
    expect(primary.lastAuthorization).toBe(`Bearer ${PROVIDER_KEY}`);
  });

  it('fails over to the secondary when the primary is rate limited', async () => {
    const { url, primary, secondary } = await start();
    primary.setBehavior({ kind: 'status', status: 429 });
    const response = await call(url, VALID);
    expect(response.status).toBe(200);
    expect(primary.requests).toBe(1);
    expect(secondary.requests).toBe(1);
  });

  it('fails over when the primary never answers within its timeout', async () => {
    const { url, primary, secondary } = await start({ primaryTimeoutMs: 300 });
    primary.setBehavior({ kind: 'hang' });
    const started = Date.now();
    const response = await call(url, VALID);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(secondary.requests).toBe(1);
  });
});

describe('request validation and auth', () => {
  it.each([
    ['no authorization', undefined],
    ['a non-bearer scheme', 'Basic abcdef'],
    ['a malformed bearer', 'Bearer a b'],
  ])('answers 401 for %s', async (_label, authorization) => {
    const { url } = await start();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(VALID) });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHORIZED',
    );
  });

  it.each([
    ['not JSON', '{nope'],
    ['a missing max_tokens', { prompt: 'x' }],
    ['an unknown field', { ...VALID, temperature: 0 }],
    ['max_tokens too large', { prompt: 'x', max_tokens: 5000 }],
    ['an empty prompt', { prompt: '', max_tokens: 1 }],
    ['a fractional max_tokens', { prompt: 'x', max_tokens: 1.5 }],
  ])('answers 400 for %s', async (_label, body) => {
    const { url, primary } = await start();
    const response = await call(url, body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_REQUEST',
    );
    expect(primary.requests).toBe(0);
  });

  it('answers 413 for a body over 64 KB', async () => {
    const { url } = await start();
    const response = await call(url, { prompt: 'a'.repeat(70_000), max_tokens: 1 });
    expect(response.status).toBe(413);
  });

  it('answers 404 and 405 for the wrong path and method', async () => {
    const { url } = await start();
    expect((await fetch(url.replace('/v1/completions', '/nope'), { method: 'POST' })).status).toBe(
      404,
    );
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
  });
});

describe('errors', () => {
  it('answers 429 with Retry-After and the fixed error shape', async () => {
    const { url, primary } = await start({ limit: 10 });
    // Each request costs ceil(4 / 4) + 4 = 5 and settles to the 4 the stub reports.
    const body = { prompt: 'abcd', max_tokens: 4 };
    let response = await call(url, body);
    for (let attempt = 0; attempt < 5 && response.status === 200; attempt++) {
      response = await call(url, body);
    }
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const error = (await response.json()) as { error: Record<string, unknown> };
    expect(Object.keys(error)).toEqual(['error']);
    expect(Object.keys(error.error).sort()).toEqual(['code', 'message', 'request_id']);
    expect(error.error.code).toBe('RATE_LIMITED');
    expect(primary.requests).toBeGreaterThanOrEqual(2);
  });

  it('admits a request that lands exactly on the limit', async () => {
    // Limit 9, each request costs 5 and settles to 4: the second lands exactly on the limit.
    const { url } = await start({ limit: 9 });
    const body = { prompt: 'abcd', max_tokens: 4 };
    expect((await call(url, body)).status).toBe(200);
    expect((await call(url, body)).status).toBe(200);
    expect((await call(url, body)).status).toBe(429);
  });

  it('answers UPSTREAM_UNAVAILABLE with a clean body when both providers fail', async () => {
    const { url, primary, secondary } = await start();
    primary.setBehavior({ kind: 'status', status: 500 });
    secondary.setBehavior({ kind: 'status', status: 500 });
    const response = await call(url, VALID);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toMatch(/provider internal detail|127\.0\.0\.1|stack|\/home|\\\\/);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'The model provider is unavailable',
        request_id: expect.any(String) as string,
      },
    });
  });

  it('answers UPSTREAM_REJECTED for a provider 400, without failing over', async () => {
    const { url, primary, secondary } = await start();
    primary.setBehavior({ kind: 'status', status: 400 });
    const response = await call(url, VALID);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'UPSTREAM_REJECTED',
    );
    expect(secondary.requests).toBe(0);
  });

  it('logs the failure detail with the request id, and never the key or the prompt', async () => {
    const { url, primary, sink } = await start();
    primary.setBehavior({ kind: 'status', status: 400 });
    const response = await call(url, { prompt: 'private prompt text', max_tokens: 5 });
    const requestId = response.headers.get('x-request-id');
    const body = (await response.json()) as { error: { request_id: string } };
    expect(body.error.request_id).toBe(requestId);
    const logged = sink.chunks.join('');
    expect(logged).toContain(body.error.request_id);
    expect(logged).toContain('provider rejected request');
    expect(logged).not.toContain('private prompt text');
    expect(logged).not.toContain(CLIENT_KEY);
    expect(logged).not.toContain(PROVIDER_KEY);
  });
});

describe('real default timeout (slow)', () => {
  it('fails over after the default 3000 ms when the primary hangs', async () => {
    // The default comes from the config, not from this test.
    const defaults = parseRouterConfig({
      PRIMARY_MODEL_URL: 'http://127.0.0.1:1/v1/completions',
      PRIMARY_API_KEY: PROVIDER_KEY,
      SECONDARY_MODEL_URL: 'http://127.0.0.1:1/v1/completions',
      SECONDARY_API_KEY: PROVIDER_KEY,
    });
    if (!defaults.ok) throw new Error('defaults must parse');
    expect(defaults.config.primary.timeoutMs).toBe(3000);
    const { url, primary, secondary } = await start({
      primaryTimeoutMs: defaults.config.primary.timeoutMs,
    });
    primary.setBehavior({ kind: 'hang' });
    const started = Date.now();
    const response = await call(url, VALID);
    const elapsed = Date.now() - started;
    expect(response.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(6000);
    expect(secondary.requests).toBe(1);
  }, 15_000);
});
