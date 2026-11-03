import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGuardrailConfig } from '../src/config.js';
import { redactText, REDACTED } from '../src/redactor.js';
import { createStubProvider, type StubProvider } from '../stub-provider/server.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const KEY = 'provider-key-0123456789';
const children: ChildProcess[] = [];
const providers: StubProvider[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

describe('parseGuardrailConfig', () => {
  it('applies defaults', () => {
    expect(parseGuardrailConfig({ LLM_PROVIDER_API_KEY: KEY })).toEqual({
      ok: true,
      config: {
        port: 8090,
        providerUrl: 'http://127.0.0.1:8091/v1/chat/completions',
        providerApiKey: KEY,
      },
    });
  });

  it('treats a blank port as the default and accepts a port', () => {
    expect(parseGuardrailConfig({ LLM_PROVIDER_API_KEY: KEY, GUARDRAIL_PORT: '  ' })).toMatchObject(
      {
        ok: true,
        config: { port: 8090 },
      },
    );
    expect(
      parseGuardrailConfig({ LLM_PROVIDER_API_KEY: KEY, GUARDRAIL_PORT: '9000' }),
    ).toMatchObject({
      ok: true,
      config: { port: 9000 },
    });
  });

  it.each(['-1', '65536', '1.5', 'abc', '0x1F90', '1e3'])('rejects port %j', (value) => {
    expect(parseGuardrailConfig({ LLM_PROVIDER_API_KEY: KEY, GUARDRAIL_PORT: value })).toEqual({
      ok: false,
      fields: ['GUARDRAIL_PORT'],
    });
  });

  it.each([
    'ftp://h/v1/chat/completions',
    'javascript:alert(1)',
    'not a url',
    'http://user:pass@h/v1/chat/completions',
  ])('rejects the provider URL %j', (value) => {
    expect(parseGuardrailConfig({ LLM_PROVIDER_API_KEY: KEY, LLM_PROVIDER_URL: value })).toEqual({
      ok: false,
      fields: ['LLM_PROVIDER_URL'],
    });
  });

  it('requires the provider key and names it without echoing secrets', () => {
    const result = parseGuardrailConfig({ GUARDRAIL_PORT: 'oops' });
    expect(result).toEqual({ ok: false, fields: ['GUARDRAIL_PORT', 'LLM_PROVIDER_API_KEY'] });
    expect(JSON.stringify(result)).not.toContain('oops');
  });
});

describe('npm run task3 entry', () => {
  it('is wired as a package script', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.task3).toBe('tsx --env-file-if-exists=.env task3-stream-guardrail/index.ts');
    expect(pkg.scripts['task3:provider']).toBe(
      'tsx --env-file-if-exists=.env task3-stream-guardrail/stub-provider/index.ts',
    );
    expect(pkg.scripts['test:task3']).toBe('vitest run task3-stream-guardrail');
  });

  it('starts, redacts a streamed answer end to end, and logs without secrets', async () => {
    const provider = createStubProvider({ script: () => 'Mail a@b.com now', chunkSize: 3 });
    providers.push(provider);
    const { url: providerUrl } = await provider.listen();

    const child = spawn(process.execPath, ['--import', 'tsx', 'task3-stream-guardrail/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LOG_LEVEL: 'info',
        GUARDRAIL_PORT: '0',
        LLM_PROVIDER_URL: providerUrl,
        LLM_PROVIDER_API_KEY: KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    const listening = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway did not start')), 8000);
      const poll = setInterval(() => {
        const match = /"url":"(http:\/\/[^"]+)"/.exec(stderr);
        if (match?.[1]) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(match[1]);
        }
      }, 50);
    });

    const response = await fetch(listening, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client' },
      body: JSON.stringify({
        model: 'stub',
        stream: true,
        messages: [{ role: 'user', content: 'Mail a@b.com now' }],
      }),
    });
    const text = await response.text();
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(text).not.toContain('a@b.com');
    expect(text).toContain(REDACTED);
    expect(redactText('Mail a@b.com now')).toBe(`Mail ${REDACTED} now`);
    expect(stdout).toBe('');
    expect(stderr).not.toContain(KEY);
    expect(stderr).not.toContain('a@b.com');
  });

  it('exits 1 naming only the bad setting', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'task3-stream-guardrail/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, LLM_PROVIDER_API_KEY: '', GUARDRAIL_PORT: 'x', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('invalid configuration');
    expect(stderr).toContain('GUARDRAIL_PORT');
    expect(stderr).not.toMatch(/\bat \S+:\d+/);
  });
});
