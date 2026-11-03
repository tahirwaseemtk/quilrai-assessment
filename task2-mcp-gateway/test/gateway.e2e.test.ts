import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { createMockDownstream, type MockDownstream } from '../mock-downstream/server.js';
import { bearer, postRpc } from './helpers/mcp-http.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const entry = 'task2-mcp-gateway/index.ts';
const children: ChildProcess[] = [];
const mocks: MockDownstream[] = [];

const ADMIN = 'e2e-admin-token-0123456789';
const VIEWER = 'e2e-viewer-token-0123456789';
const DT = 'e2e-downstream-token-0123';
const STRONG_TOKENS = JSON.stringify({ [ADMIN]: 'admin', [VIEWER]: 'viewer' });
const PLACEHOLDER_TOKENS =
  '{"replace-with-admin-token":"admin","replace-with-viewer-token":"viewer"}';

// No --env-file, and every setting the gateway reads is pinned: neither a developer's .env nor
// their shell may change what these tests see.
function spawnGateway(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LOG_LEVEL: 'info',
    GATEWAY_PORT: '0',
    DOWNSTREAM_MCP_URL: undefined,
    DOWNSTREAM_TIMEOUT_MS: undefined,
    DOWNSTREAM_AUTH_TOKEN: DT,
    GATEWAY_TOKENS: STRONG_TOKENS,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  return {
    child,
    output: () => ({ stdout, stderr }),
    logLines: () =>
      stderr
        .split('\n')
        .slice(0, -1)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the gateway');
}

async function startMock(): Promise<string> {
  const mock = createMockDownstream({
    authToken: DT,
    logger: createLogger({ service: 'mock-downstream', sink: new CaptureSink() }),
  });
  mocks.push(mock);
  return (await mock.listen()).url;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(mocks.splice(0).map((mock) => mock.close()));
});

describe('npm run task2 entry', () => {
  it('is the package script', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.task2).toBe('tsx --env-file-if-exists=.env task2-mcp-gateway/index.ts');
  });

  it('starts, logs its port and proxies tools/list to the downstream', async () => {
    const gateway = spawnGateway({ DOWNSTREAM_MCP_URL: await startMock() });
    const listening = await waitFor(() =>
      gateway.logLines().find((line) => line.msg === 'listening'),
    );
    expect(listening).toMatchObject({ service: 'task2-mcp-gateway', level: 'info' });
    const port = listening.port as number;
    expect(port).toBeGreaterThan(0);

    const response = await postRpc(
      `http://127.0.0.1:${port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      bearer(VIEWER),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.json)).toContain('admin_reset_key');

    const { stdout, stderr } = gateway.output();
    expect(stdout).toBe('');
    for (const secret of [ADMIN, VIEWER, DT]) expect(stderr).not.toContain(secret);
    expect(gateway.logLines().filter((line) => line.level === 'warn')).toEqual([]);
  });

  it('warns once about placeholder tokens without logging them', async () => {
    const gateway = spawnGateway({
      DOWNSTREAM_MCP_URL: await startMock(),
      GATEWAY_TOKENS: PLACEHOLDER_TOKENS,
    });
    await waitFor(() => gateway.logLines().find((line) => line.msg === 'listening'));
    expect(gateway.logLines().filter((line) => line.level === 'warn')).toEqual([
      expect.objectContaining({ msg: 'GATEWAY_TOKENS contains a placeholder or short token' }),
    ]);
    expect(gateway.output().stderr).not.toContain('replace-with-admin-token');
  });

  it('exits 1 with a logged code when the port is taken', async () => {
    const first = spawnGateway({ DOWNSTREAM_MCP_URL: await startMock() });
    const listening = await waitFor(() =>
      first.logLines().find((line) => line.msg === 'listening'),
    );
    const second = spawnGateway({ GATEWAY_PORT: String(listening.port) });
    const code = await new Promise<number | null>((resolve) => second.child.on('close', resolve));
    expect(code).toBe(1);
    expect(second.logLines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ msg: 'listen failed', error_code: 'EADDRINUSE' }),
    ]);
    expect(second.output().stderr).not.toMatch(/\bat \S+:\d+/);
  });

  it.each([
    ['DOWNSTREAM_AUTH_TOKEN', { DOWNSTREAM_AUTH_TOKEN: undefined }],
    ['GATEWAY_TOKENS', { GATEWAY_TOKENS: '{"strong-token-xyz-1":"root"}' }],
    ['DOWNSTREAM_TIMEOUT_MS', { DOWNSTREAM_TIMEOUT_MS: '0' }],
  ])('exits 1 naming only %s when it is invalid', async (field, env) => {
    const gateway = spawnGateway(env);
    // 'close' (not 'exit') fires after stdio is drained, so the last log line has been read.
    const code = await new Promise<number | null>((resolve) => gateway.child.on('close', resolve));
    expect(code).toBe(1);
    expect(gateway.logLines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ msg: 'invalid configuration', fields: [field] }),
    ]);
    const { stderr } = gateway.output();
    expect(stderr).not.toContain('strong-token-xyz-1');
    expect(stderr).not.toMatch(/\bat \S+:\d+/);
  });
});
