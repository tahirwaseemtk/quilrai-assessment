import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Logger } from '../../shared/logger.js';
import { hasBearerToken } from '../src/bearer.js';

export interface ToolCallRecord {
  name: string;
  arguments: unknown;
}

export interface MockDownstreamOptions {
  // The gateway's downstream credential; client tokens must never be accepted here.
  authToken: string;
  logger: Logger;
  // false answers with an SSE stream, so the gateway's streaming passthrough can be tested.
  jsonResponse?: boolean;
}

export interface MockDownstream {
  readonly calls: readonly ToolCallRecord[];
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PATH = '/mcp';

// Matches the error shape of Task 1 (ADR 012): numeric code, exact message, no SDK prefix.
class MockRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const emptyArgs = z.strictObject({});
const tools = [
  {
    name: 'get_status',
    description: 'Report service status.',
    args: emptyArgs,
    run: () => ({ status: 'ok' }),
  },
  {
    name: 'admin_reset_key',
    description: 'Reset an API key (admin only behind the gateway).',
    args: z.strictObject({ key_id: z.string().min(1) }),
    run: (input: { key_id: string }) => ({ reset: true, key_id: input.key_id }),
  },
  {
    name: 'admin',
    description: 'Administrative entry point (admin only behind the gateway).',
    args: emptyArgs,
    run: () => ({ admin: true }),
  },
] as const;

function createMcpServer(calls: ToolCallRecord[]): Server {
  const server = new Server(
    { name: 'mock-downstream', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, args }) => ({
      name,
      description,
      inputSchema: z.toJSONSchema(args) as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) throw new MockRpcError(-32602, 'Unknown tool');
    const parsed = tool.args.safeParse(request.params.arguments ?? {});
    if (!parsed.success) throw new MockRpcError(-32602, 'Invalid params');
    const result = (tool.run as (input: unknown) => unknown)(parsed.data);
    // Recorded only after the tool ran, so tests can assert "the downstream executed nothing".
    calls.push(structuredClone({ name: tool.name, arguments: parsed.data }));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  return server;
}

// A real MCP server over Streamable HTTP (stateless, one transport per request, as the SDK
// requires), standing in for the service behind the gateway in tests and demos.
export function createMockDownstream(options: MockDownstreamOptions): MockDownstream {
  if (options.authToken.trim() === '') throw new Error('authToken must be a non-empty string');
  const { authToken, logger, jsonResponse = true } = options;
  const calls: ToolCallRecord[] = [];

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' }).end('Method Not Allowed');
      return;
    }
    if (!hasBearerToken(req.headers.authorization, authToken)) {
      logger.warn('unauthorized request', { path: pathname });
      res
        .writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' })
        .end('Unauthorized');
      return;
    }

    const server = createMcpServer(calls);
    // No sessionIdGenerator: the transport runs stateless, so no initialize handshake is needed.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: jsonResponse });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // No parsed body is passed, so the SDK reads and validates the raw request itself.
    await transport.handleRequest(req, res);
    logger.debug('mcp request handled', { status: res.statusCode });
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error('mock downstream failed', { error });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal Server Error');
    });
  });

  return {
    get calls() {
      return structuredClone(calls);
    },
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        // Only startup errors reject; the listener is removed once listening succeeds.
        httpServer.once('error', reject);
        httpServer.listen(port, HOST, () => {
          httpServer.off('error', reject);
          const { port: bound } = httpServer.address() as AddressInfo;
          resolve({ url: `http://${HOST}:${bound}${PATH}`, port: bound });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
    },
  };
}
