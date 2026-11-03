import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestId } from '../../shared/jsonrpc-envelope.js';
import type { Logger } from '../../shared/logger.js';
import { authenticate } from './auth.js';
import { authorize } from './authorize.js';
import { isJsonContentType } from './content-type.js';
import { classifyBody, type ClassifiedBody } from './envelope.js';
import { CLIENT_CLOSED, forwardRequest, MAX_RELAY_BYTES } from './forward.js';
import { decodeUtf8, MAX_BODY_BYTES, readBody, withoutByteOrderMark } from './read-body.js';
import { sendJson, sendText } from './responses.js';
import { RpcCode, rpcError, type RpcCodeValue, type RpcErrorResponse } from './rpc-errors.js';
import { isValidToolName } from './tool-name.js';
import type { Role, TokenTable } from './token-config.js';

export interface GatewayOptions {
  table: TokenTable;
  downstreamUrl: string;
  downstreamToken: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  // Tests lower the cap; production uses MAX_RELAY_BYTES.
  maxResponseBytes?: number;
  logger: Logger;
}

export interface Gateway {
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PATH = '/mcp';
const SINGLE_VALUE_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;
// Malformed input is the client's error (400); a well-formed request with bad params is answered
// like any other JSON-RPC result (200).
function replyStatus(response: RpcErrorResponse): number {
  const { code } = response.error;
  return code === RpcCode.ParseError || code === RpcCode.InvalidRequest ? 400 : 200;
}

function rpcMethodOf(classified: ClassifiedBody): string | undefined {
  switch (classified.kind) {
    case 'tool-call':
      return 'tools/call';
    case 'request':
    case 'notification':
      return classified.method;
    default:
      return undefined;
  }
}

function idOf(classified: ClassifiedBody): RequestId | null {
  return classified.kind === 'tool-call' || classified.kind === 'request' ? classified.id : null;
}

// The name check comes first: a name the gate cannot judge reliably is refused, not guessed at.
function refuseToolCall(role: Role, toolName: string): RpcCodeValue | undefined {
  if (!isValidToolName(toolName)) return RpcCode.InvalidParams;
  return authorize(role, toolName) === 'deny' ? RpcCode.UnauthorizedToolCall : undefined;
}

export function createGateway(options: GatewayOptions): Gateway {
  const { table, logger } = options;
  const target = {
    url: options.downstreamUrl,
    token: options.downstreamToken,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxBytes: options.maxResponseBytes ?? MAX_RELAY_BYTES,
  };

  // Each step answers or passes on; the order is part of the contract (cheap checks first, no
  // body read before authentication) and is pinned by tests.
  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    log: { rpcMethod?: string },
  ): Promise<number> {
    // The raw request-target, not new URL(), which throws on targets such as "http://[/mcp". The
    // query is dropped: the downstream URL is fixed by configuration.
    if ((req.url ?? '').split('?')[0] !== PATH) return sendText(req, res, 404, 'Not Found');
    if (req.method !== 'POST') {
      return sendText(req, res, 405, 'Method Not Allowed', { allow: 'POST' });
    }
    // One response for every failure reason, so the reason never leaks.
    const auth = authenticate(req.headersDistinct.authorization, table);
    if (!auth.ok) {
      return sendText(req, res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    }
    if (!isJsonContentType(req.headersDistinct['content-type'])) {
      return sendText(req, res, 415, 'Unsupported Media Type');
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      return sendText(req, res, 413, 'Payload Too Large');
    }
    // Two session ids or protocol versions are as ambiguous as two Authorization headers: Node
    // would join them into one value the downstream may read differently.
    if (SINGLE_VALUE_HEADERS.some((name) => (req.headersDistinct[name]?.length ?? 0) > 1)) {
      return sendText(req, res, 400, 'Bad Request');
    }

    let body: Awaited<ReturnType<typeof readBody>>;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      // The client disconnected mid-body.
      return CLIENT_CLOSED;
    }
    if (!body.ok) return sendText(req, res, 413, 'Payload Too Large');

    // classifyBody strips the one accepted BOM itself; decoding must not strip another.
    const text = decodeUtf8(body.bytes);
    if (text === undefined) return sendJson(res, 400, rpcError(null, RpcCode.ParseError));

    const classified = classifyBody(text);
    const rpcMethod = rpcMethodOf(classified);
    if (rpcMethod !== undefined) log.rpcMethod = rpcMethod;
    if (classified.kind === 'reply') {
      return sendJson(res, replyStatus(classified.response), classified.response);
    }
    if (classified.kind === 'drop') {
      res.writeHead(202).end();
      return 202;
    }

    if (classified.kind === 'tool-call') {
      const refusal = refuseToolCall(auth.role, classified.toolName);
      if (refusal !== undefined) {
        const response = rpcError(classified.id, refusal);
        return sendJson(res, replyStatus(response), response);
      }
    }

    return forwardRequest({
      req,
      res,
      body: withoutByteOrderMark(body.bytes),
      id: idOf(classified),
      target,
      logger,
    });
  }

  // One line per request, with no headers, body, tokens or URL.
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = performance.now();
    const log: { rpcMethod?: string } = {};
    let status: number;
    try {
      status = await route(req, res, log);
    } catch {
      // Any throw here is a gateway fault, answered without detail.
      logger.error('gateway request failed');
      if (res.headersSent) {
        res.destroy();
        status = res.statusCode;
      } else {
        status = sendJson(res, 500, rpcError(null, RpcCode.InternalError));
      }
    }
    logger.info('request', {
      http_method: req.method,
      ...(log.rpcMethod === undefined ? {} : { rpc_method: log.rpcMethod }),
      status,
      duration_ms: Math.round(performance.now() - started),
    });
  }

  const server = http.createServer((req, res) => void handle(req, res));

  return {
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const { port: bound } = server.address() as AddressInfo;
          resolve({ url: `http://${HOST}:${bound}${PATH}`, port: bound });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
