import { describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../src/tool-schemas.js';
import { logLines, npmSilentLaunch, rawSession, withClient } from './helpers/process.js';

type Line = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const toolNames = ['get_customer_record', 'trigger_refund'];
const leakPattern = /MCP error|ZodError|"issues"|\bat \S+:\d+/;

const initialize =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}';

function parseJsonRpcLine(line: string): Line {
  const parsed = JSON.parse(line) as Line;
  expect(parsed.jsonrpc).toBe('2.0');
  expect(('result' in parsed ? 1 : 0) + ('error' in parsed ? 1 : 0)).toBe(1);
  expect(parsed.error?.data).toBeUndefined();
  return parsed;
}

const structured = (result: unknown): Record<string, unknown> =>
  (result as { structuredContent: Record<string, unknown> }).structuredContent;

const toolCall = (id: number, name: string, args: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('stdio server process', () => {
  it('connects with the SDK client, lists tools and reports unknown tools', async () => {
    const pid = await withClient(async ({ client, pid }) => {
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(toolNames);
      const error = await client.callTool({ name: 'nope' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(-32602);
      expect((error as McpError).message).toContain('Unknown tool');
      return pid;
    });
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid as number, 0)).toThrow();
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
    for (const line of stdoutLines) expect(line).not.toMatch(leakPattern);
    const lines = stdoutLines.map(parseJsonRpcLine);
    const byId = (id: unknown) => lines.filter((line) => line.id === id);

    expect(byId(null).map((line) => line.error)).toEqual([
      { code: -32700, message: 'Parse error' },
      { code: -32600, message: 'Invalid Request' },
      { code: -32600, message: 'Invalid Request' },
    ]);
    expect(byId(1)[0]?.result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(byId(2)[0]?.error).toEqual({ code: -32601, message: 'Method not found' });
    const listed = byId(3)[0]?.result as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(byId(4)[0]?.error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(byId(5)[0]?.error).toEqual({ code: -32602, message: 'Unknown tool' });
    expect(byId(6)[0]?.result).toEqual({});

    const logs = logLines(stderrLines);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(JSON.parse(line)).toHaveProperty('level');
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
    // npm's script banner arrives on stdout before the server starts; the client skips it.
    await withClient(
      async ({ client }) => {
        expect(client.getServerVersion()?.name).toBe('quilr-customer-mcp');
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(toolNames);
      },
      { command: 'npm', args: ['run', 'task1'] },
    );
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

describe('customer tools through the real server', () => {
  const getRecord = { name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } };
  const refund50 = {
    name: 'trigger_refund',
    arguments: { customer_id: 'CUST-00001', amount: 50, reason: 'Damaged on arrival' },
  };

  it('lists both tools with their schemas and annotations', async () => {
    await withClient(async ({ client }) => {
      expect((await client.listTools()).tools).toEqual([
        expect.objectContaining({
          name: 'get_customer_record',
          inputSchema: getCustomerRecordInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        }),
        expect.objectContaining({
          name: 'trigger_refund',
          inputSchema: triggerRefundInputSchema,
          annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        }),
      ]);
    });
  });

  it('reads a record, refunds, and reads the reduced balance', async () => {
    await withClient(async ({ client }) => {
      expect(structured(await client.callTool(getRecord))).toMatchObject({
        refundable_balance: 250,
      });
      expect(structured(await client.callTool(refund50))).toMatchObject({
        refund_id: 'REF-000001',
        remaining_balance: 200,
      });
      expect(structured(await client.callTool(getRecord))).toMatchObject({
        refundable_balance: 200,
      });
    });
  });

  it('reports business failures as isError and bad input as -32602', async () => {
    await withClient(async ({ client }) => {
      expect(
        await client.callTool({
          name: 'get_customer_record',
          arguments: { customer_id: 'CUST-99999' },
        }),
      ).toEqual({ content: [{ type: 'text', text: 'Customer not found' }], isError: true });

      const error = await client
        .callTool({ ...refund50, arguments: { ...refund50.arguments, amount: 0 } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code: -32602 });
      expect((error as McpError).message).toContain('Invalid params');
    });
  });

  it('starts every process with fresh mock data', async () => {
    await withClient(async ({ client }) => {
      await client.callTool(refund50);
      expect(structured(await client.callTool(getRecord))).toMatchObject({
        refundable_balance: 200,
      });
    });
    await withClient(async ({ client }) => {
      expect(structured(await client.callTool(getRecord))).toMatchObject({
        refundable_balance: 250,
      });
    });
  });

  it('keeps stdout pure JSON-RPC and logs no refund reason', async () => {
    const sentinel = 'Email jane.doe@example.com re SSN 123-45-6789';
    const { stdoutLines, stderrLines, exitCode } = await rawSession([
      initialize,
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      toolCall(3, 'get_customer_record', { customer_id: 'CUST-00001' }),
      toolCall(4, 'get_customer_record', { customer_id: 'CUST-99999' }),
      toolCall(5, 'trigger_refund', { customer_id: 'CUST-00001', amount: 25, reason: sentinel }),
      toolCall(6, 'trigger_refund', {
        customer_id: 'CUST-00003',
        amount: 5,
        reason: 'Late delivery fee',
      }),
      toolCall(7, 'trigger_refund', { customer_id: 'CUST-00001', amount: -1, reason: sentinel }),
      '{bad json',
    ]);

    expect(exitCode).toBe(0);
    // 9 inputs, one of them a notification, which gets no reply.
    expect(stdoutLines).toHaveLength(8);
    for (const line of stdoutLines) expect(line).not.toMatch(leakPattern);
    const lines = stdoutLines.map(parseJsonRpcLine);
    const byId = (id: unknown) => lines.find((line) => line.id === id);

    expect(structured(byId(3)?.result)).toMatchObject({ customer_id: 'CUST-00001' });
    expect(byId(4)?.result).toMatchObject({ isError: true });
    expect(structured(byId(5)?.result)).toMatchObject({
      refund_id: 'REF-000001',
      reason: sentinel,
    });
    expect(byId(6)?.result).toMatchObject({ isError: true });
    expect(byId(7)?.error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(byId(null)?.error).toEqual({ code: -32700, message: 'Parse error' });
    expect(stdoutLines.filter((line) => line.includes('jane.doe'))).toHaveLength(1);

    const logs = logLines(stderrLines);
    expect(logs.some((line) => line.includes('"refund_id":"REF-000001"'))).toBe(true);
    for (const line of logs) expect(JSON.parse(line)).toHaveProperty('level');
    for (const line of stderrLines) {
      expect(line).not.toContain('jane.doe');
      expect(line).not.toContain('123-45-6789');
    }
  });
});
