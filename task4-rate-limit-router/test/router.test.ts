import { describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { openDatabase } from '../src/db.js';
import { createLimiter } from '../src/limiter.js';
import type { ProviderClient, ProviderOutcome } from '../src/providers.js';
import { route, type RouterDeps } from '../src/router.js';
import type { CompletionRequest } from '../src/request.js';
import { tenantHash } from '../src/tenant.js';

// A provider that replays the outcomes it is given and counts its calls.
function scripted(...outcomes: ProviderOutcome[]): ProviderClient & { calls: number } {
  let index = 0;
  const client = {
    calls: 0,
    complete() {
      client.calls++;
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index++;
      if (outcome === undefined) return Promise.reject(new Error('no scripted outcome'));
      return Promise.resolve(outcome);
    },
  };
  return client;
}

const OK: ProviderOutcome = { kind: 'ok', body: '{"ok":true}', totalTokens: 7 };
const TENANT = tenantHash('router-tenant-key-0123');
const REQUEST: CompletionRequest = { prompt: 'hello there', max_tokens: 10 };

function deps(options: {
  limit?: number;
  primary: ProviderClient;
  secondary: ProviderClient;
}): RouterDeps & { sink: CaptureSink; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(':memory:');
  const sink = new CaptureSink();
  return {
    db,
    sink,
    limiter: createLimiter({
      db,
      clock: { now: () => Date.now() },
      limit: options.limit ?? 1000,
      windowMs: 60_000,
      reservationTtlMs: 60_000,
    }),
    primary: options.primary,
    secondary: options.secondary,
    logger: createLogger({ service: 'task4-rate-limit-router', sink }),
  };
}

const run = (d: RouterDeps, request: CompletionRequest = REQUEST) =>
  route({ tenant: TENANT, request, body: JSON.stringify(request), requestId: 'req-1' }, d);

describe('routing', () => {
  it('serves from the primary and settles the reservation to the reported usage', async () => {
    const primary = scripted(OK);
    const secondary = scripted(OK);
    const d = deps({ primary, secondary });
    expect(await run(d)).toEqual({ ok: true, body: '{"ok":true}' });
    expect(secondary.calls).toBe(0);
    expect(d.db.prepare('SELECT tokens, status FROM usage').get()).toEqual({
      tokens: 7,
      status: 'settled',
    });
  });

  it.each([
    ['a 429', { kind: 'retryable', reason: 'status 429' } as const],
    ['a 5xx', { kind: 'retryable', reason: 'status 503' } as const],
    ['a timeout', { kind: 'retryable', reason: 'timeout' } as const],
    ['a network error', { kind: 'retryable', reason: 'network' } as const],
  ])('fails over to the secondary on %s', async (_label, failure) => {
    const primary = scripted(failure);
    const secondary = scripted(OK);
    const d = deps({ primary, secondary });
    expect(await run(d)).toEqual({ ok: true, body: '{"ok":true}' });
    expect(secondary.calls).toBe(1);
  });

  it('does not fail over on a primary rejection, and releases the reservation', async () => {
    const primary = scripted({ kind: 'rejected', status: 400 });
    const secondary = scripted(OK);
    const d = deps({ primary, secondary });
    expect(await run(d)).toEqual({ ok: false, code: 'UPSTREAM_REJECTED' });
    expect(secondary.calls).toBe(0);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 0 });
  });

  it('answers UPSTREAM_UNAVAILABLE when both providers fail, and releases the reservation', async () => {
    const primary = scripted({ kind: 'retryable', reason: 'timeout' });
    const secondary = scripted({ kind: 'retryable', reason: 'status 500' });
    const d = deps({ primary, secondary });
    expect(await run(d)).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 0 });
  });

  it('does not reach any provider when the tenant is over its limit', async () => {
    const primary = scripted(OK);
    const secondary = scripted(OK);
    // Cost of REQUEST is 13; with 13 already reserved, the next one does not fit.
    const d = deps({ limit: 20, primary, secondary });
    d.limiter.reserve(TENANT, 13);
    expect(await run(d)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: expect.any(Number) as number,
    });
    expect(primary.calls + secondary.calls).toBe(0);
  });

  it('refuses a request larger than the whole limit without calling a provider', async () => {
    const primary = scripted(OK);
    const secondary = scripted(OK);
    const d = deps({ limit: 5, primary, secondary });
    expect(await run(d)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(primary.calls + secondary.calls).toBe(0);
  });

  it('answers UPSTREAM_REJECTED when the secondary rejects after a primary failure, and releases', async () => {
    const primary = scripted({ kind: 'retryable', reason: 'timeout' });
    const secondary = scripted({ kind: 'rejected', status: 422 });
    const d = deps({ primary, secondary });
    expect(await run(d)).toEqual({ ok: false, code: 'UPSTREAM_REJECTED' });
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 0 });
  });

  it('settles to the secondary usage after a primary failure', async () => {
    const primary = scripted({ kind: 'retryable', reason: 'timeout' });
    const secondary = scripted({ kind: 'ok', body: '{}', totalTokens: 3 });
    const d = deps({ primary, secondary });
    await run(d);
    expect(d.db.prepare('SELECT tokens, status FROM usage').get()).toEqual({
      tokens: 3,
      status: 'settled',
    });
  });

  it('logs the request id without the prompt or the tenant key', async () => {
    const d = deps({ primary: scripted(OK), secondary: scripted(OK) });
    await run(d, { prompt: 'secret prompt text', max_tokens: 5 });
    const logged = d.sink.chunks.join('');
    expect(logged).toContain('req-1');
    expect(logged).not.toContain('secret prompt text');
    expect(logged).not.toContain('router-tenant-key');
  });
});
