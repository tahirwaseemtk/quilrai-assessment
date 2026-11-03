import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../../shared/logger.js';
import { ErrorCode, ErrorMessage, ErrorStatus, type ErrorCodeValue } from './errors.js';
import type { Limiter } from './limiter.js';
import type { ProviderClient } from './providers.js';
import { completionRequest } from './request.js';
import { route } from './router.js';
import { parseTenantKey, tenantHash } from './tenant.js';

export interface RouterServerOptions {
  limiter: Limiter;
  primary: ProviderClient;
  secondary: ProviderClient;
  logger: Logger;
}

export interface RouterServer {
  listen(port?: number): Promise<{ url: string; port: number }>;
  // Stops accepting work and resolves once in-flight requests have finished (or after a bound),
  // so the database is never closed under a request that is still reserving or settling.
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PATH = '/v1/completions';
const MAX_BODY_BYTES = 65_536;
const DRAIN_MS = 5000;
// Bounds how long a client may take to send its headers and its whole request.
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

// The one error shape the API returns. The request id is the only link to the detail in the logs.
function sendError(
  res: http.ServerResponse,
  requestId: string,
  code: ErrorCodeValue,
  retryAfterSeconds?: number,
): number {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': requestId,
  };
  if (retryAfterSeconds !== undefined) headers['retry-after'] = String(retryAfterSeconds);
  res.writeHead(ErrorStatus[code], headers).end(
    JSON.stringify({
      error: { code, message: ErrorMessage[code], request_id: requestId },
    }),
  );
  return ErrorStatus[code];
}

// Resolves with the body, or undefined once it is over the limit. An oversized body is read to the
// end and discarded rather than destroyed, so the 413 can still reach the client.
function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const onData = (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
  });
}

export function createRouterServer(options: RouterServerOptions): RouterServer {
  const { logger } = options;
  let inFlight = 0;

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId: string,
  ): Promise<number> {
    if ((req.url ?? '').split('?')[0] !== PATH) {
      return sendError(res, requestId, ErrorCode.NotFound);
    }
    if (req.method !== 'POST') return sendError(res, requestId, ErrorCode.MethodNotAllowed);

    const apiKey = parseTenantKey(req.headers.authorization);
    if (apiKey === undefined) return sendError(res, requestId, ErrorCode.Unauthorized);

    const raw = await readBody(req);
    if (raw === undefined) return sendError(res, requestId, ErrorCode.PayloadTooLarge);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return sendError(res, requestId, ErrorCode.InvalidRequest);
    }
    const parsed = completionRequest.safeParse(json);
    if (!parsed.success) return sendError(res, requestId, ErrorCode.InvalidRequest);

    const result = await route(
      {
        tenant: tenantHash(apiKey),
        request: parsed.data,
        body: JSON.stringify(parsed.data),
        requestId,
      },
      { limiter: options.limiter, primary: options.primary, secondary: options.secondary, logger },
    );
    if (!result.ok) return sendError(res, requestId, result.code, result.retryAfterSeconds);
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': requestId });
    res.end(result.body);
    return 200;
  }

  const server = http.createServer((req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    inFlight++;
    handle(req, res, requestId)
      .catch(() => {
        // The same id goes back to the client and into the log, so the failure can be found.
        logger.error('router request failed', { request_id: requestId });
        if (!res.headersSent) return sendError(res, requestId, ErrorCode.Internal);
        res.destroy();
        return 500;
      })
      .then((status) => {
        logger.info('request', {
          request_id: requestId,
          http_method: req.method,
          status,
          duration_ms: Math.round(performance.now() - started),
        });
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight--;
      });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

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
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      const deadline = Date.now() + DRAIN_MS;
      while (inFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
