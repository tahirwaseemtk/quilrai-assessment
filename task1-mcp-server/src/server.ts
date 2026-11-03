import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ErrorCode, ErrorMessage, RpcError } from './errors.js';
import { describeArgumentIssues, type ArgumentField } from './field-errors.js';
import type { Logger } from '../../shared/logger.js';

type ToolResult = CallToolResult | Promise<CallToolResult>;

// `args` is required so no tool can be registered without validation; the server parses the
// arguments before any handler runs.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
  args: z.ZodType;
  // Fields that get field-level -32602 messages; without them errors stay "Invalid params".
  argumentFields?: readonly ArgumentField[];
  handler: (input: unknown) => ToolResult;
}

export function defineTool<S extends z.ZodType>(
  tool: Omit<ToolDefinition, 'args' | 'handler'> & {
    args: S;
    handler: (input: z.output<S>) => ToolResult;
  },
): ToolDefinition {
  // Sound only because runTool always parses with this same `args` before calling the handler.
  return tool as ToolDefinition;
}

export async function runTool(tool: ToolDefinition, args: unknown): Promise<CallToolResult> {
  // MCP makes `arguments` optional; treating its absence as {} reports which fields are missing.
  const input = args === undefined ? {} : args;
  const parsed = tool.args.safeParse(input);
  if (!parsed.success) {
    const message = describeArgumentIssues(parsed.error.issues, input, tool.argumentFields ?? []);
    throw new RpcError(ErrorCode.InvalidParams, message);
  }
  return tool.handler(parsed.data);
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
      return await runTool(tool, request.params.arguments);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      logger.error('tool handler failed', { tool: tool.name, error });
      throw new RpcError(ErrorCode.InternalError, ErrorMessage.InternalError);
    }
  });

  server.onerror = (error) => logger.warn('protocol error', { error });
  return server;
}
