import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CallToolResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createMockCustomerRepository,
  type CustomerRepository,
} from '../src/customer-repository.js';
import { RpcError } from '../src/errors.js';
import { ArgumentMessage } from '../src/field-errors.js';
import { createLogger } from '../src/logger.js';
import { createServer, defineTool, type ToolDefinition } from '../src/server.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../src/tool-schemas.js';
import { createTools } from '../src/tools.js';
import { CaptureSink, createHarness, flush } from './helpers/streams.js';

const serverInfo = { name: 'test-server', version: '9.9.9' };

async function connect(tools: ToolDefinition[] = []) {
  const logSink = new CaptureSink();
  const logger = createLogger({ sink: logSink, level: 'debug' });
  const server = createServer({ logger, tools, info: serverInfo });
  const harness = createHarness();
  await server.connect(harness.transport);
  const call = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    harness.input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    for (let i = 0; i < 20; i += 1) {
      await flush();
      const response = harness
        .outputLines()
        .find((line) => (line as { id?: unknown }).id === message.id);
      if (response) return response as Record<string, unknown>;
    }
    throw new Error(`no response for id ${String(message.id)}`);
  };
  return { call, logSink, server };
}

const initialize = (protocolVersion: string) => ({
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});

describe('createServer', () => {
  it('completes initialize with tools capability and configured server info', async () => {
    const { call } = await connect();
    const response = await call(initialize('2025-06-18'));
    expect(response.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo,
    });
  });

  it('negotiates the latest protocol version for an unsupported request', async () => {
    const { call } = await connect();
    const response = await call(initialize('1999-01-01'));
    expect((response.result as { protocolVersion: string }).protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    );
  });

  it('lists no tools before any are registered', async () => {
    const { call } = await connect();
    expect(await call({ id: 3, method: 'tools/list' })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [] },
    });
  });

  it('answers an unknown tool with -32602 Unknown tool', async () => {
    const { call } = await connect();
    expect(await call({ id: 5, method: 'tools/call', params: { name: 'nope' } })).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32602, message: 'Unknown tool' },
    });
  });

  it('answers an unknown method with -32601', async () => {
    const { call } = await connect();
    expect(await call({ id: 2, method: 'nope' })).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('passes an RpcError thrown by a tool to the wire unchanged', async () => {
    const tool: ToolDefinition = {
      name: 'strict',
      description: 'throws an RpcError',
      inputSchema: { type: 'object' },
      args: z.unknown(),
      handler: () => {
        throw new RpcError(-32602, 'Unknown tool');
      },
    };
    const { call } = await connect([tool]);
    expect(await call({ id: 6, method: 'tools/call', params: { name: 'strict' } })).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32602, message: 'Unknown tool' },
    });
  });

  it('validates arguments with the tool schema before the handler runs', async () => {
    let calls = 0;
    const tool = defineTool({
      name: 'typed',
      description: 'accepts only { n: number }',
      inputSchema: { type: 'object' },
      args: z.strictObject({ n: z.number() }),
      handler: ({ n }) => {
        calls += 1;
        return { content: [{ type: 'text', text: String(n) }] };
      },
    });
    const { call } = await connect([tool]);
    expect(
      await call({ id: 8, method: 'tools/call', params: { name: 'typed', arguments: { n: 'x' } } }),
    ).toEqual({ jsonrpc: '2.0', id: 8, error: { code: -32602, message: 'Invalid params' } });
    expect(calls).toBe(0);
    const ok = await call({
      id: 9,
      method: 'tools/call',
      params: { name: 'typed', arguments: { n: 2 } },
    });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: '2' }] });
    expect(calls).toBe(1);
  });

  it('hides a plain Error behind -32603 and logs the detail to the sink', async () => {
    const tool: ToolDefinition = {
      name: 'broken',
      description: 'throws a plain Error',
      inputSchema: { type: 'object' },
      args: z.unknown(),
      handler: () => {
        throw new Error('secret C:\\path');
      },
    };
    const { call, logSink } = await connect([tool]);
    const response = await call({ id: 7, method: 'tools/call', params: { name: 'broken' } });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(logSink.chunks.join('')).toContain('secret');
  });
});

describe('registered tools', () => {
  const mockTools = (repository: CustomerRepository = createMockCustomerRepository()) =>
    createTools(repository, createLogger({ sink: new CaptureSink() }));
  const callTool = (id: number, name: string, args?: unknown) => ({
    id,
    method: 'tools/call',
    params: args === undefined ? { name } : { name, arguments: args },
  });
  const refundArgs = { customer_id: 'CUST-00001', amount: 50, reason: 'Damaged on arrival' };

  it('lists both tools in a result the SDK accepts', async () => {
    const { call } = await connect(mockTools());
    const { result } = await call({ id: 1, method: 'tools/list' });
    const listed = ListToolsResultSchema.parse(result);
    for (const tool of listed.tools) expect(ToolSchema.safeParse(tool).success).toBe(true);
    expect(result).toEqual({
      tools: [
        {
          name: 'get_customer_record',
          description: expect.any(String) as string,
          inputSchema: getCustomerRecordInputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: 'trigger_refund',
          description: expect.any(String) as string,
          inputSchema: triggerRefundInputSchema,
          annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
      ],
    });
  });

  it('returns tool results the SDK accepts', async () => {
    const { call } = await connect(mockTools());
    const record = await call(callTool(2, 'get_customer_record', { customer_id: 'CUST-00001' }));
    const refund = await call(callTool(3, 'trigger_refund', refundArgs));
    expect(CallToolResultSchema.safeParse(record.result).success).toBe(true);
    expect(CallToolResultSchema.safeParse(refund.result).success).toBe(true);
    expect(refund.result).toMatchObject({
      structuredContent: { refund_id: 'REF-000001', remaining_balance: 200 },
    });
  });

  it('returns business failures as isError results, not JSON-RPC errors', async () => {
    const { call } = await connect(mockTools());
    const response = await call(
      callTool(4, 'trigger_refund', { ...refundArgs, customer_id: 'CUST-00003' }),
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'Customer account is closed' }], isError: true },
    });
    expect(CallToolResultSchema.safeParse(response.result).success).toBe(true);
  });

  it.each([
    ['missing arguments', undefined, `Invalid params: ${ArgumentMessage.CustomerIdRequired}`],
    ['empty arguments', {}, `Invalid params: ${ArgumentMessage.CustomerIdRequired}`],
    ['short id', { customer_id: 'CUST-1' }, `Invalid params: ${ArgumentMessage.CustomerId}`],
    [
      'extra key',
      { customer_id: 'CUST-00001', extra: 1 },
      `Invalid params: ${ArgumentMessage.UnknownArguments}`,
    ],
  ])('answers %s with a field-level -32602', async (_label, args, message) => {
    const { call } = await connect(mockTools());
    const response = await call(callTool(5, 'get_customer_record', args));
    expect(response).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32602, message } });
    expect(JSON.stringify(response)).not.toMatch(/issues|Zod|expected/);
  });

  // Non-object arguments are rejected by the inbound classifier before any tool runs.
  it.each([
    ['null arguments', null],
    ['array arguments', []],
    ['string arguments', 's'],
    ['number arguments', 1],
  ])('answers %s with the envelope-level -32602', async (_label, args) => {
    const { call } = await connect(mockTools());
    expect(await call(callTool(5, 'get_customer_record', args))).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32602, message: 'Invalid params' },
    });
  });

  it.each([
    ['too many decimals', { ...refundArgs, amount: 0.001 }, ArgumentMessage.Amount],
    ['short reason', { ...refundArgs, reason: '012345678' }, ArgumentMessage.Reason],
    [
      'no arguments',
      {},
      [
        ArgumentMessage.CustomerIdRequired,
        ArgumentMessage.AmountRequired,
        ArgumentMessage.ReasonRequired,
      ].join('; '),
    ],
  ])('answers a refund with %s with a field-level -32602', async (_label, args, fragments) => {
    const { call } = await connect(mockTools());
    expect((await call(callTool(6, 'trigger_refund', args))).error).toEqual({
      code: -32602,
      message: `Invalid params: ${fragments}`,
    });
  });

  const rawCall = (line: string) => JSON.parse(line) as Record<string, unknown>;

  it('never echoes prototype-like key names from the wire', async () => {
    const { call } = await connect(mockTools());
    const response = await call(
      rawCall(
        '{"id":12,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"x","constructor":1,"toString":1}}}',
      ),
    );
    expect(response.error).toEqual({
      code: -32602,
      message: `Invalid params: ${ArgumentMessage.CustomerId}; ${ArgumentMessage.UnknownArguments}`,
    });
    expect(JSON.stringify(response)).not.toMatch(/constructor|toString/);
  });

  // The SDK drops an own __proto__ argument key before validation; inbound rejects it instead.
  it.each(['{"x":1}', 'null', '"s"'])(
    'rejects __proto__ as the only extra argument (value %s)',
    async (value) => {
      const { call } = await connect(mockTools());
      const response = await call(
        rawCall(
          `{"id":13,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-00001","__proto__":${value}}}}`,
        ),
      );
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 13,
        error: { code: -32602, message: 'Invalid params' },
      });
    },
  );

  it('keeps state across calls', async () => {
    const { call } = await connect(mockTools());
    await call(callTool(7, 'trigger_refund', refundArgs));
    const record = await call(callTool(8, 'get_customer_record', { customer_id: 'CUST-00001' }));
    expect(record.result).toMatchObject({ structuredContent: { refundable_balance: 200 } });
  });

  it('masks a repository failure as -32603 and logs the detail', async () => {
    const broken: CustomerRepository = {
      find: () => {
        throw new Error('db C:\\secret');
      },
      refund: () => {
        throw new Error('db C:\\secret');
      },
    };
    const { call, logSink } = await connect(mockTools(broken));
    const response = await call(callTool(9, 'get_customer_record', { customer_id: 'CUST-00001' }));
    expect(response.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(logSink.chunks.join('')).toContain('secret');
  });

  it('cannot overdraw with pipelined refunds', async () => {
    const harness = createHarness();
    const server = createServer({
      logger: createLogger({ sink: new CaptureSink() }),
      tools: mockTools(),
      info: serverInfo,
    });
    await server.connect(harness.transport);
    const big = { ...refundArgs, amount: 150 };
    harness.input.write(
      `${JSON.stringify({ jsonrpc: '2.0', ...callTool(10, 'trigger_refund', big) })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', ...callTool(11, 'trigger_refund', big) })}\n`,
    );
    for (let i = 0; i < 20 && harness.outputLines().length < 2; i += 1) await flush();
    await flush();
    expect(harness.outputLines()).toHaveLength(2);
    const results = harness.outputLines().map((line) => (line as { result: unknown }).result);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          structuredContent: expect.objectContaining({ remaining_balance: 100 }) as unknown,
        }),
        {
          content: [{ type: 'text', text: 'Refund amount exceeds refundable balance' }],
          isError: true,
        },
      ]),
    );
  });
});
