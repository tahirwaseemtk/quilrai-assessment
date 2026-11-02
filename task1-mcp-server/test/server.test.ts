import { describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { RpcError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { createServer, type ToolDefinition } from '../src/server.js';
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

  it('hides a plain Error behind -32603 and logs the detail to the sink', async () => {
    const tool: ToolDefinition = {
      name: 'broken',
      description: 'throws a plain Error',
      inputSchema: { type: 'object' },
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
