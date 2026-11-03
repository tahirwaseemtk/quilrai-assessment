import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRouterConfig } from '../src/config.js';
import { createStubProvider, type StubProvider } from '../stub-providers/server.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const KEY = 'provider-key-0123456789abcdef';
const children: ChildProcess[] = [];
const stubs: StubProvider[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Wait for each child to exit before deleting its database: Windows keeps the WAL file locked
  // until the process has closed it.
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.kill();
        }),
    ),
  );
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REQUIRED = {
  PRIMARY_MODEL_URL: 'http://127.0.0.1:8101/v1/completions',
  PRIMARY_API_KEY: KEY,
  SECONDARY_MODEL_URL: 'http://127.0.0.1:8102/v1/completions',
  SECONDARY_API_KEY: KEY,
};

describe('parseRouterConfig', () => {
  it('applies the defaults', () => {
    expect(parseRouterConfig(REQUIRED)).toEqual({
      ok: true,
      config: {
        port: 8100,
        sqlitePath: 'data/rate-limit.db',
        limit: 50_000,
        windowMs: 60_000,
        primary: { url: REQUIRED.PRIMARY_MODEL_URL, apiKey: KEY, timeoutMs: 3000 },
        secondary: { url: REQUIRED.SECONDARY_MODEL_URL, apiKey: KEY, timeoutMs: 3000 },
      },
    });
  });

  it('treats blank values as unset', () => {
    expect(
      parseRouterConfig({ ...REQUIRED, ROUTER_PORT: '  ', RATE_LIMIT_TOKENS: '' }),
    ).toMatchObject({
      ok: true,
      config: { port: 8100, limit: 50_000 },
    });
  });

  it.each([
    ['RATE_LIMIT_TOKENS', '0'],
    ['RATE_LIMIT_TOKENS', '1.5'],
    ['RATE_LIMIT_WINDOW_MS', '999'],
    ['PRIMARY_TIMEOUT_MS', '0x10'],
    ['SECONDARY_TIMEOUT_MS', '1e3'],
    ['ROUTER_PORT', '70000'],
  ])('rejects %s=%s, naming only the field', (name, value) => {
    expect(parseRouterConfig({ ...REQUIRED, [name]: value })).toEqual({
      ok: false,
      fields: [name],
    });
  });

  it('rejects a provider URL with credentials or a non-http scheme', () => {
    expect(parseRouterConfig({ ...REQUIRED, PRIMARY_MODEL_URL: 'http://u:p@h/x' })).toEqual({
      ok: false,
      fields: ['PRIMARY_MODEL_URL'],
    });
    expect(parseRouterConfig({ ...REQUIRED, SECONDARY_MODEL_URL: 'file:///etc/passwd' })).toEqual({
      ok: false,
      fields: ['SECONDARY_MODEL_URL'],
    });
  });

  it('requires both provider keys and names them without echoing values', () => {
    const result = parseRouterConfig({ RATE_LIMIT_TOKENS: 'secret-looking' });
    expect(result).toEqual({
      ok: false,
      fields: [
        'RATE_LIMIT_TOKENS',
        'PRIMARY_MODEL_URL',
        'PRIMARY_API_KEY',
        'SECONDARY_MODEL_URL',
        'SECONDARY_API_KEY',
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-looking');
  });
});

describe('npm run task4 entry', () => {
  it('is wired as package scripts', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.task4).toBe(
      'tsx --env-file-if-exists=.env task4-rate-limit-router/index.ts',
    );
    expect(pkg.scripts['task4:providers']).toBe(
      'tsx --env-file-if-exists=.env task4-rate-limit-router/stub-providers/index.ts',
    );
    expect(pkg.scripts['test:task4']).toBe('vitest run task4-rate-limit-router');
  });

  it('starts, serves a request through the stubs, and keeps secrets out of its logs', async () => {
    const primary = createStubProvider();
    const secondary = createStubProvider();
    stubs.push(primary, secondary);
    const primaryAt = await primary.listen();
    await secondary.listen();
    const dir = mkdtempSync(path.join(tmpdir(), 'rl-e2e-'));
    dirs.push(dir);

    const child = spawn(process.execPath, ['--import', 'tsx', 'task4-rate-limit-router/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LOG_LEVEL: 'info',
        ROUTER_PORT: '0',
        SQLITE_PATH: path.join(dir, 'rate-limit.db'),
        PRIMARY_MODEL_URL: primaryAt.url,
        PRIMARY_API_KEY: KEY,
        SECONDARY_MODEL_URL: primaryAt.url,
        SECONDARY_API_KEY: KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('router did not start')), 8000);
      const poll = setInterval(() => {
        const match = /"url":"(http:\/\/[^"]+)"/.exec(stderr);
        if (match?.[1]) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(match[1]);
        }
      }, 50);
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer client-key-0123456789',
      },
      body: JSON.stringify({ prompt: 'hello', max_tokens: 5 }),
    });
    expect(response.status).toBe(200);
    expect(stdout).toBe('');
    expect(stderr).not.toContain(KEY);
    expect(stderr).not.toContain('client-key-0123456789');
    expect(stderr).not.toContain('hello');
  });

  it('exits 1 naming only the bad setting', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'task4-rate-limit-router/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...REQUIRED,
        PRIMARY_API_KEY: KEY,
        RATE_LIMIT_TOKENS: '0',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('invalid configuration');
    expect(stderr).toContain('RATE_LIMIT_TOKENS');
    expect(stderr).not.toContain(KEY);
    expect(stderr).not.toMatch(/\bat \S+:\d+/);
  });
});
