import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLimiter, RateLimitedError } from '../src/limiter.js';
import { openDatabase } from '../src/db.js';
import { tenantHash } from '../src/tenant.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A manual clock makes the window deterministic.
function setup(limit = 100, windowMs = 1000) {
  const db = openDatabase(':memory:');
  let now = 10_000;
  const clock = { now: () => now };
  const limiter = createLimiter({ db, clock, limit, windowMs, reservationTtlMs: windowMs });
  return {
    db,
    limiter,
    tick: (ms: number) => (now += ms),
    set: (value: number) => (now = value),
  };
}

const TENANT = tenantHash('tenant-a-key-0123456789');

describe('reserve', () => {
  it('admits a request that lands exactly on the limit', () => {
    const { limiter } = setup(100);
    expect(() => limiter.reserve(TENANT, 60)).not.toThrow();
    expect(() => limiter.reserve(TENANT, 40)).not.toThrow();
  });

  it('refuses one token over the limit with a Retry-After in seconds', () => {
    const { limiter } = setup(100, 1000);
    limiter.reserve(TENANT, 100);
    expect.assertions(2);
    try {
      limiter.reserve(TENANT, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).retryAfterSeconds).toBe(1);
    }
  });

  it('frees the window as rows age out', () => {
    const { limiter, tick } = setup(100, 1000);
    limiter.reserve(TENANT, 100);
    expect(() => limiter.reserve(TENANT, 1)).toThrow(RateLimitedError);
    tick(1000);
    expect(() => limiter.reserve(TENANT, 100)).not.toThrow();
  });

  it('evicts expired rows from the table on each check', () => {
    const { db, limiter, tick } = setup(100, 1000);
    limiter.reserve(TENANT, 10);
    limiter.reserve(TENANT, 10);
    tick(1000);
    limiter.reserve(TENANT, 10);
    const count = db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps tenants apart', () => {
    const { limiter } = setup(100);
    limiter.reserve(TENANT, 100);
    expect(() => limiter.reserve(tenantHash('tenant-b-key-0123456789'), 100)).not.toThrow();
  });

  it('stores only the tenant hash, never the raw key', () => {
    const { db, limiter } = setup(100);
    limiter.reserve(TENANT, 5);
    const dump = JSON.stringify(db.prepare('SELECT * FROM usage').all());
    expect(dump).toContain(TENANT);
    expect(dump).not.toContain('tenant-a-key');
  });
});

describe('reconcile and release', () => {
  it('replaces the estimate with the reported usage', () => {
    const { db, limiter } = setup(100);
    const reservation = limiter.reserve(TENANT, 80);
    limiter.reconcile(reservation, 12);
    const row = db.prepare('SELECT tokens, status FROM usage').get() as {
      tokens: number;
      status: string;
    };
    expect(row).toEqual({ tokens: 12, status: 'settled' });
    expect(() => limiter.reserve(TENANT, 88)).not.toThrow();
  });

  it('frees the reservation when no provider served the request', () => {
    const { limiter } = setup(100);
    const reservation = limiter.reserve(TENANT, 100);
    expect(() => limiter.reserve(TENANT, 1)).toThrow(RateLimitedError);
    limiter.release(reservation);
    expect(() => limiter.reserve(TENANT, 100)).not.toThrow();
  });
});

describe('database file', () => {
  it('uses WAL mode and creates the directory for an on-disk path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rl-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'rate-limit.db');
    const db = openDatabase(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(existsSync(file)).toBe(true);
    db.close();
  });
});

describe('concurrency across connections', () => {
  it('lets exactly the tokens in the limit through when two processes race', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rl-race-'));
    dirs.push(dir);
    const databasePath = path.join(dir, 'race.db');
    const startFile = path.join(dir, 'start');
    // Create the schema first so both children open an existing database.
    openDatabase(databasePath).close();

    // Limit 1000, each request costs 100: exactly 10 may be granted across both processes.
    const helper = path.join(repoRoot, 'task4-rate-limit-router/test/helpers/reserve-once.ts');
    const launch = () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', helper, databasePath, startFile, '1000', '100', '30'],
          {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(Number(out.trim())) : reject(new Error(err)),
        );
      });

    const first = launch();
    const second = launch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(startFile, 'go');
    const granted = (await Promise.all([first, second])).reduce((a, b) => a + b, 0);
    expect(granted).toBe(10);
    expect(readFileSync(startFile, 'utf8')).toBe('go');
  }, 30_000);
});

describe('open reservations outlive the window', () => {
  it('keeps an in-flight reservation counted past the window, until its TTL', () => {
    const db = openDatabase(':memory:');
    let now = 10_000;
    const limiter = createLimiter({
      db,
      clock: { now: () => now },
      limit: 100,
      windowMs: 1000,
      reservationTtlMs: 5000,
    });
    limiter.reserve(TENANT, 100);
    now += 2000; // the window has passed, but the provider call may still be running
    expect(() => limiter.reserve(TENANT, 1)).toThrow(RateLimitedError);
    now += 5000; // past the TTL: the reservation has gone
    expect(() => limiter.reserve(TENANT, 100)).not.toThrow();
  });
});
