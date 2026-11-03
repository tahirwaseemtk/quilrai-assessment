import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, postRpc } from './helpers/mcp-http.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const entry = 'task2-mcp-gateway/mock-downstream/index.ts';
const children: ChildProcess[] = [];

// No --env-file, and the settings the mock reads are pinned: neither a developer's .env nor
// their shell (e.g. LOG_LEVEL=error) may change what these tests see.
function spawnMock(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LOG_LEVEL: 'info',
    MOCK_DOWNSTREAM_PORT: undefined,
    DOWNSTREAM_AUTH_TOKEN: undefined,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv))
    if (value === undefined) delete childEnv[key];
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
    // Only complete lines: the last segment may still be arriving.
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
  throw new Error('timed out waiting for the mock downstream');
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe('npm run task2:mock entry', () => {
  it('starts, logs its port to stderr and serves MCP', async () => {
    const mock = spawnMock({ MOCK_DOWNSTREAM_PORT: '0', DOWNSTREAM_AUTH_TOKEN: 'e2e-tok' });
    const listening = await waitFor(() => mock.logLines().find((line) => line.msg === 'listening'));
    expect(listening).toMatchObject({ service: 'mock-downstream', level: 'info' });
    const port = listening.port as number;
    expect(port).toBeGreaterThan(0);

    const response = await postRpc(
      `http://127.0.0.1:${port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      bearer('e2e-tok'),
    );
    expect(response.status).toBe(200);
    expect(mock.output().stdout).toBe('');
    expect(mock.output().stderr).not.toContain('e2e-tok');
  });

  it('exits with code 1 and a fixed message when the token is missing', async () => {
    const mock = spawnMock({ MOCK_DOWNSTREAM_PORT: '0', DOWNSTREAM_AUTH_TOKEN: undefined });
    // 'close' (not 'exit') fires after stdio is drained, so the last log line has been read.
    const code = await new Promise<number | null>((resolve) => mock.child.on('close', resolve));
    expect(code).toBe(1);
    const errors = mock.logLines().filter((line) => line.level === 'error');
    expect(errors).toEqual([
      expect.objectContaining({ service: 'mock-downstream', msg: 'invalid configuration' }),
    ]);
    expect(mock.output().stderr).not.toMatch(/\bat \S+:\d+/);
  });
});
