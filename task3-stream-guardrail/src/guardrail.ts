import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { Logger } from '../../shared/logger.js';
import { createStreamingRedactor, type StreamingRedactor } from './redactor.js';
import { type ChunkMessage, DONE, encodeEvent, parseChunk, sseDataPayloads } from './sse.js';

export interface GuardrailOptions {
  providerUrl: string;
  providerApiKey: string;
  logger: Logger;
  // Time allowed for the provider to send its headers.
  headerTimeoutMs?: number;
  // Longest silence allowed from the provider, or from a client that stops reading, mid-stream.
  streamIdleMs?: number;
  // Called once per stream with the redactor's peak holdback, for tests and metrics.
  onStats?: (stats: { peakHeld: number }) => void;
}

export interface Guardrail {
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PATH = '/v1/chat/completions';
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_IDLE_MS = 30_000;

// Only the fields the provider needs are forwarded, so client-supplied extras never reach it.
const requestSchema = z.object({
  model: z.string().min(1).max(200),
  stream: z.literal(true),
  messages: z
    .array(z.object({ role: z.string().min(1).max(50), content: z.string() }))
    .min(1)
    .max(200),
});

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): number {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: { code, message } }));
  return status;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

// Resolves true once the client has drained. Resolves false if the client closed, or stayed
// unready for too long, so a stream never waits on a socket that will not drain.
function writeFrame(res: http.ServerResponse, frame: string, stallMs: number): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(frame)) return Promise.resolve(true);
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

// Passes the provider's bytes through, failing if nothing arrives for too long. The timer only
// runs while the gateway waits for the provider, never while the client is being written to.
async function* withIdleLimit(
  source: AsyncIterable<Uint8Array>,
  idleMs: number,
  onIdle: () => void,
): AsyncGenerator<Uint8Array> {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(onIdle, idleMs);
  };
  arm();
  try {
    for await (const chunk of source) {
      clearTimeout(timer);
      yield chunk;
      arm();
    }
  } finally {
    clearTimeout(timer);
  }
}

// The frame sent to the client: the same envelope with the allowlisted fields only.
function frameOf(chunk: ChunkMessage, delta: Record<string, string>, finish: string | null) {
  return {
    id: chunk.id,
    object: chunk.object ?? 'chat.completion.chunk',
    model: chunk.model,
    created: chunk.created,
    choices: [{ index: chunk.choices?.[0]?.index ?? 0, delta, finish_reason: finish }],
  };
}

// Relays the provider's chunks with their content redacted. Returns when the stream ends or the
// client can no longer be written to, so the caller stops the provider.
async function relayRedacted(
  res: http.ServerResponse,
  providerBody: AsyncIterable<Uint8Array>,
  redactor: StreamingRedactor,
  logger: Logger,
  stallMs: number,
): Promise<void> {
  for await (const payload of sseDataPayloads(providerBody)) {
    if (payload === DONE) break;
    const chunk = parseChunk(payload);
    if (chunk === undefined) {
      logger.warn('provider sent a non-chunk event; dropped');
      continue;
    }
    // Usage-only and empty chunks carry no text, so there is nothing to redact or forward.
    const choice = chunk.choices?.[0];
    if (choice === undefined) continue;

    const content = choice.delta?.content;
    const finish = choice.finish_reason ?? null;
    if (content === undefined && finish === null) {
      // Role-only deltas are forwarded so the client sees the speaker; tool calls and other
      // non-text deltas are dropped.
      const role = choice.delta?.role;
      if (role !== undefined) {
        const frame = encodeEvent(frameOf(chunk, { role }, null));
        if (!(await writeFrame(res, frame, stallMs))) return;
      }
      continue;
    }
    // A finishing chunk drains the holdback first, so no held text is lost at the end.
    const text =
      (content === undefined ? '' : redactor.push(content)) +
      (finish === null ? '' : redactor.flush());
    const frame = encodeEvent(frameOf(chunk, { content: text }, finish));
    if (!(await writeFrame(res, frame, stallMs))) return;
  }
  // A provider that ends without a finish chunk still has held text to release.
  const rest = redactor.flush();
  if (rest !== '') {
    await writeFrame(
      res,
      encodeEvent({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: rest } }],
      }),
      stallMs,
    );
  }
}

export function createGuardrail(options: GuardrailOptions): Guardrail {
  const { logger } = options;
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  const streamIdleMs = options.streamIdleMs ?? DEFAULT_IDLE_MS;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<number> {
    if ((req.url ?? '').split('?')[0] !== PATH) {
      return sendError(res, 404, 'NOT_FOUND', 'Not found');
    }
    if (req.method !== 'POST')
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error instanceof Error && error.message === 'too large') {
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      }
      return sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON');
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return sendError(
        res,
        400,
        'INVALID_REQUEST',
        'stream must be true and messages must be given',
      );
    }

    const controller = new AbortController();
    const onClose = () => {
      // Client gone: stop the provider so no more tokens are generated for nobody.
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    const headerTimer = setTimeout(() => controller.abort(), headerTimeoutMs);

    let upstream: Response;
    try {
      upstream = await fetch(options.providerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${options.providerApiKey}`,
        },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(headerTimer);
      res.off('close', onClose);
      if (res.destroyed) return 499;
      logger.error('provider unreachable');
      return sendError(res, 502, 'UPSTREAM_UNAVAILABLE', 'The model provider is unavailable');
    }
    clearTimeout(headerTimer);

    if (!upstream.ok || upstream.body === null) {
      await upstream.body?.cancel().catch(() => undefined);
      res.off('close', onClose);
      logger.error('provider returned an error status', { provider_status: upstream.status });
      return sendError(res, 502, 'UPSTREAM_UNAVAILABLE', 'The model provider is unavailable');
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const redactor = createStreamingRedactor();
    try {
      const source = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
      const idleBounded = withIdleLimit(source, streamIdleMs, () => {
        logger.warn('provider stream idle; ended', { reason: 'idle' });
        controller.abort();
      });
      await relayRedacted(res, idleBounded, redactor, logger, streamIdleMs);
      if (!res.destroyed) await writeFrame(res, `data: ${DONE}\n\n`, streamIdleMs);
    } catch {
      // The provider failed mid-stream: the status is already sent, so end the stream.
      logger.error('provider stream failed');
    } finally {
      controller.abort();
      res.off('close', onClose);
      options.onStats?.({ peakHeld: redactor.peakHeld });
    }
    if (!res.writableEnded) res.end();
    return 200;
  }

  const server = http.createServer((req, res) => {
    const started = performance.now();
    handle(req, res)
      .catch(() => {
        logger.error('guardrail request failed');
        if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'Internal error');
        else res.destroy();
        return 500;
      })
      .then((status) => {
        logger.info('request', {
          http_method: req.method,
          status,
          duration_ms: Math.round(performance.now() - started),
        });
      })
      .catch(() => undefined);
  });

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
