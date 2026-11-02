import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  npmSilentLaunch,
  rawSession,
  repoRoot,
  serverArgs,
  serverCommand,
} from './helpers/process.js';

type Line = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const initialize =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}';

function parseJsonRpcLine(line: string): Line {
  const parsed = JSON.parse(line) as Line;
  expect(parsed.jsonrpc).toBe('2.0');
  expect(('result' in parsed ? 1 : 0) + ('error' in parsed ? 1 : 0)).toBe(1);
  expect(parsed.error?.data).toBeUndefined();
  return parsed;
}

describe('stdio server process', () => {
  it('connects with the SDK client, lists tools and reports unknown tools', async () => {
    const transport = new StdioClientTransport({
      command: serverCommand,
      args: serverArgs,
      cwd: repoRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      expect(await client.listTools()).toEqual({ tools: [] });
      const error = await client.callTool({ name: 'nope' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(-32602);
      expect((error as McpError).message).toContain('Unknown tool');
    } finally {
      const pid = transport.pid;
      await client.close();
      expect(pid).not.toBeNull();
      expect(() => process.kill(pid as number, 0)).toThrow();
    }
  });

  it('writes only JSON-RPC to stdout and only logs to stderr in a scripted session', async () => {
    const { stdoutLines, stderrLines, exitCode } = await rawSession([
      '{bad json',
      '{"foo":1}',
      '[]',
      initialize,
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"nope"}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":4,"method":"tools/call"}',
      '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}',
      '{"jsonrpc":"2.0","id":6,"method":"ping"}',
      '{"jsonrpc":"2.0","method":"notifications/x","params":"bad"}',
    ]);

    expect(exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(9);
    for (const line of stdoutLines) {
      expect(line).not.toMatch(/MCP error|ZodError|issues|\bat \S+:\d+/);
    }
    const lines = stdoutLines.map(parseJsonRpcLine);
    const byId = (id: unknown) => lines.filter((line) => line.id === id);

    expect(byId(null).map((line) => line.error)).toEqual([
      { code: -32700, message: 'Parse error' },
      { code: -32600, message: 'Invalid Request' },
      { code: -32600, message: 'Invalid Request' },
    ]);
    expect(byId(1)[0]?.result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(byId(2)[0]?.error).toEqual({ code: -32601, message: 'Method not found' });
    expect(byId(3)[0]?.result).toEqual({ tools: [] });
    expect(byId(4)[0]?.error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(byId(5)[0]?.error).toEqual({ code: -32602, message: 'Unknown tool' });
    expect(byId(6)[0]?.result).toEqual({});

    // Node itself reports a missing .env file on stderr; every other line is a structured log.
    const logLines = stderrLines.filter((line) => !line.startsWith('.env not found'));
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(JSON.parse(line)).toHaveProperty('level');
    }
  });

  it('keeps answering after repeated malformed input', async () => {
    const lines: string[] = [];
    for (let id = 1; id <= 20; id += 1) {
      lines.push('{bad json', `{"jsonrpc":"2.0","id":${id},"method":"ping"}`);
    }
    const { stdoutLines, exitCode } = await rawSession(lines);
    const parsed = stdoutLines.map(parseJsonRpcLine);
    expect(exitCode).toBe(0);
    expect(parsed.filter((line) => line.error?.code === -32700)).toHaveLength(20);
    expect(
      parsed
        .filter((line) => line.result !== undefined)
        .map((line) => line.id)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rejects an oversize line and keeps running', async () => {
    const { stdoutLines, exitCode } = await rawSession([
      'j'.repeat(1024 * 1024 + 1),
      '{"jsonrpc":"2.0","id":7,"method":"ping"}',
    ]);
    expect(exitCode).toBe(0);
    expect(stdoutLines.map(parseJsonRpcLine)).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]);
  });

  it('exits cleanly when stdin ends', async () => {
    const { stdoutLines, exitCode } = await rawSession([initialize]);
    expect(exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(1);
  });
});

describe('launching through npm', () => {
  it('npm run task1 connects with the SDK client', { timeout: 30_000 }, async () => {
    const transport = new StdioClientTransport({
      command: 'npm',
      args: ['run', 'task1'],
      cwd: repoRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-npm', version: '0' });
    // npm's script banner arrives on stdout before the server starts; the client skips it.
    client.onerror = () => undefined;
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('quilr-customer-mcp');
      expect(await client.listTools()).toEqual({ tools: [] });
    } finally {
      await client.close();
    }
  });

  it('npm run --silent task1 writes only JSON-RPC to stdout', { timeout: 30_000 }, async () => {
    const { stdoutLines, exitCode } = await rawSession(
      [initialize, '{bad json', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'],
      { launch: npmSilentLaunch, timeoutMs: 25_000 },
    );
    expect(exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(3);
    stdoutLines.forEach(parseJsonRpcLine);
  });
});

describe('requests the SDK would otherwise drop', () => {
  it('answers each one and still shuts down cleanly', async () => {
    const { stdoutLines, stderrLines, exitCode } = await rawSession([
      '{"jsonrpc":"2.0","id":12,"method":"ping","params":{"_meta":5}}',
      '{"jsonrpc":"2.0","id":13,"method":"tools/list","params":{"cursor":5}}',
    ]);
    expect(exitCode).toBe(0);
    expect(stdoutLines.map(parseJsonRpcLine)).toEqual([
      { jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'Invalid params' } },
      { jsonrpc: '2.0', id: 13, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(stderrLines.some((line) => line.includes('server closed'))).toBe(true);
  });
});
