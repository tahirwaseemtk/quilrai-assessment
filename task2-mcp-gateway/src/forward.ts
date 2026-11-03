import type http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { RequestId } from '../../shared/jsonrpc-envelope.js';
import type { Logger } from '../../shared/logger.js';
import { sendJson } from './responses.js';
import { RpcCode, rpcError } from './rpc-errors.js';

export interface DownstreamTarget {
  url: string;
  token: string;
  timeoutMs: number;
}

export interface ForwardRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: Buffer;
  // Echoed in a 502; null when the body has no id (notification, client response).
  id: RequestId | null;
  target: DownstreamTarget;
  logger: Logger;
}

// Status for the request log line when the client left before the response was finished.
export const CLIENT_CLOSED = 499;

// Allowlists, not denylists: the client's Authorization, cookies and proxy headers never reach the
// downstream, and the downstream's Set-Cookie or WWW-Authenticate never reach the client.
const RELAYED_REQUEST_HEADERS = ['accept', 'mcp-session-id', 'mcp-protocol-version'] as const;
const RELAYED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id'] as const;

function requestHeaders(req: http.IncomingMessage, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  for (const name of RELAYED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const relayed: Record<string, string> = {};
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) relayed[name] = value;
  }
  return relayed;
}

// Only a short code (ECONNREFUSED, UND_ERR_SOCKET, ...) is logged: undici's messages and causes
// can carry the downstream URL.
function errorCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return 'UNKNOWN';
}

const sendInternalError = (res: http.ServerResponse, id: RequestId | null): number =>
  sendJson(res, 502, rpcError(id, RpcCode.InternalError));

// Forwards one request and relays the response, streaming the body (JSON or SSE) without
// buffering it. Returns the status for the request log.
export async function forwardRequest({
  req,
  res,
  body,
  id,
  target,
  logger,
}: ForwardRequest): Promise<number> {
  const controller = new AbortController();
  let clientClosed = false;
  let downstreamFailed = false;
  const onClose = () => {
    if (res.writableFinished || downstreamFailed) return;
    clientClosed = true;
    controller.abort();
  };
  res.on('close', onClose);

  // The timeout covers only the wait for response headers: an SSE stream may legitimately stay
  // open for longer.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, target.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: requestHeaders(req, target.token),
        body,
        signal: controller.signal,
        // A redirect would resend the gateway's credential to wherever the downstream points.
        redirect: 'error',
      });
    } catch (error) {
      if (clientClosed) return CLIENT_CLOSED;
      logger.error('downstream request failed', {
        error_code: timedOut ? 'TIMEOUT' : errorCode(error),
      });
      return sendInternalError(res, id);
    } finally {
      clearTimeout(timer);
    }

    // The downstream refusing the gateway's own credential is a gateway fault; relaying the 401
    // would tell the client its token was wrong.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      logger.error('downstream rejected the gateway credential', {
        downstream_status: response.status,
      });
      return sendInternalError(res, id);
    }

    res.writeHead(response.status, responseHeaders(response.headers));
    // An SSE stream may wait before its first event; the client should see the status meanwhile.
    res.flushHeaders();
    if (response.body === null) {
      res.end();
      return response.status;
    }
    const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    // Registered before pipeline() so it runs before pipeline destroys the response, letting
    // onClose tell a downstream failure from a client disconnect.
    source.once('error', () => {
      if (!clientClosed) downstreamFailed = true;
    });
    try {
      await pipeline(source, res);
    } catch (error) {
      if (clientClosed) return CLIENT_CLOSED;
      logger.warn('downstream stream failed', { error_code: errorCode(error) });
    }
    return response.status;
  } finally {
    res.off('close', onClose);
  }
}
