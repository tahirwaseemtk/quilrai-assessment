import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, ErrorMessage, RpcError } from './errors.js';
import type { Logger } from './logger.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
  handler: (args: Record<string, unknown> | undefined) => CallToolResult | Promise<CallToolResult>;
}

export interface ServerOptions {
  logger: Logger;
  tools?: ToolDefinition[];
  info?: { name: string; version: string };
}

export const SERVER_INFO = { name: 'quilr-customer-mcp', version: '0.1.0' };

// Low-level Server rather than McpServer: McpServer reports argument validation failures as
// isError tool results, while the assessment requires JSON-RPC -32602. See ADR 012.
export function createServer({ logger, tools = [], info = SERVER_INFO }: ServerOptions): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
  const registry = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      ...(annotations && { annotations }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = registry.get(request.params.name);
    if (!tool) throw new RpcError(ErrorCode.InvalidParams, ErrorMessage.UnknownTool);
    try {
      return await tool.handler(request.params.arguments);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      logger.error('tool handler failed', { tool: tool.name, error });
      throw new RpcError(ErrorCode.InternalError, ErrorMessage.InternalError);
    }
  });

  server.onerror = (error) => logger.warn('protocol error', { error });
  return server;
}
