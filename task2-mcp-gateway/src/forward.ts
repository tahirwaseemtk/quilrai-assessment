import type http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { RequestId } from '../../shared/jsonrpc-envelope.js';
import type { Logger } from '../../shared/logger.js';
import { sendJson } from './responses.js';
import { RpcCode, rpcError } from './rpc-errors.js';

export interface DownstreamTarget {
  url: string;
  token: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxBytes: number;
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

// A relayed body larger than this is cut: the gateway never buffers more than this, and a runaway
// downstream cannot fill the client's connection indefinitely.
export const MAX_RELAY_BYTES = 4 * 1024 * 1024;

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

// A relayed body that stops for longer than the idle timeout, or grows past MAX_RELAY_BYTES, ends
// the response. After headers are sent the status cannot change, so the connection is destroyed.
type RelayFailure = 'idle' | 'too-large' | 'write-stall' | 'downstream';

// A client that stops reading must not pin the downstream connection for ever.
export const WRITE_STALL_MS = 30_000;

// Resolves true once the client has drained, false if it closed or stalled too long.
function waitForDrain(res: http.ServerResponse, stallMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (drained: boolean) => {
      clearTimeout(stall);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const stall = setTimeout(() => finish(false), stallMs);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
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

// Writes the downstream body to the client chunk by chunk, honouring backpressure. Returns the
// reason the stream was cut, or undefined when it ended normally.
async function relayBody(
  source: AsyncIterable<Uint8Array>,
  res: http.ServerResponse,
  controller: AbortController,
  idleTimeoutMs: number,
  maxBytes: number,
): Promise<RelayFailure | undefined> {
  let failure: RelayFailure | undefined;
  let total = 0;
  const cut = (reason: RelayFailure) => {
    failure ??= reason;
    controller.abort();
  };
  let idle: NodeJS.Timeout | undefined;
  // The idle timer runs only while the gateway waits for the downstream, never while the client
  // is slow to read: a slow reader is not a stalled downstream.
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => cut('idle'), idleTimeoutMs);
  };
  arm();
  try {
    for await (const chunk of source) {
      clearTimeout(idle);
      total += chunk.byteLength;
      if (total > maxBytes) {
        cut('too-large');
        break;
      }
      if (!res.write(chunk) && !(await waitForDrain(res, WRITE_STALL_MS))) {
        cut(res.destroyed ? 'downstream' : 'write-stall');
        break;
      }
      arm();
    }
  } catch {
    failure ??= 'downstream';
  } finally {
    clearTimeout(idle);
  }
  if (failure === undefined) res.end();
  return failure;
}

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

    // A downstream failure page (HTML, a stack trace, a JSON-RPC error on a 5xx) is never relayed:
    // it may carry internals, and the client needs only the sanitized answer.
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      logger.error('downstream server error', { downstream_status: response.status });
      return sendInternalError(res, id);
    }

    // A declared length over the cap is refused before any byte is relayed, so the status is still
    // free to be the sanitized 502.
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > target.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      logger.error('downstream body too large', { downstream_status: response.status });
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
    // Registered before the relay so it runs before the response is destroyed, letting onClose
    // tell a downstream failure from a client disconnect.
    source.once('error', () => {
      if (!clientClosed) downstreamFailed = true;
    });
    const failure = await relayBody(source, res, controller, target.idleTimeoutMs, target.maxBytes);
    if (clientClosed) return CLIENT_CLOSED;
    if (failure !== undefined) {
      logger.warn('downstream stream ended early', { reason: failure });
      res.destroy();
    }
    return response.status;
  } finally {
    res.off('close', onClose);
  }
}
