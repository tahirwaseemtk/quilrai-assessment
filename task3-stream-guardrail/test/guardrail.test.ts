import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { MAX_HOLDBACK } from '../src/patterns.js';
import { redactText, REDACTED } from '../src/redactor.js';
import { createGuardrail, type Guardrail } from '../src/guardrail.js';
import { sseDataPayloads } from '../src/sse.js';
import { createStubProvider, type StubProvider } from '../stub-provider/server.js';
import { encodeEvent } from '../src/sse.js';

async function waitUntil(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

const PROVIDER_KEY = 'provider-key-0123456789';
const CLIENT_KEY = 'client-key-0123456789abcdef';
const SAMPLE =
  'Contact john.doe@example.com, SSN 123-45-6789, card 4111 1111 1111 1111 or 4111-1111-1111-1111. Thanks!';
const PII = ['john.doe@example.com', '123-45-6789', '4111 1111 1111 1111', '4111-1111-1111-1111'];

const running: Array<Guardrail | StubProvider> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function start(options: {
  script?: (prompt: string) => string;
  chunkSize?: number;
  delayMs?: number;
  providerUrl?: string;
  onStats?: (stats: { peakHeld: number }) => void;
  streamIdleMs?: number;
}) {
  const provider = createStubProvider({
    ...(options.script ? { script: options.script } : {}),
    ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
  });
  running.push(provider);
  const { url: providerUrl } = await provider.listen();
  const sink = new CaptureSink();
  const guardrail = createGuardrail({
    providerUrl: options.providerUrl ?? providerUrl,
    providerApiKey: PROVIDER_KEY,
    logger: createLogger({ service: 'task3-stream-guardrail', sink }),
    ...(options.onStats ? { onStats: options.onStats } : {}),
    ...(options.streamIdleMs === undefined ? {} : { streamIdleMs: options.streamIdleMs }),
  });
  running.push(guardrail);
  const { url } = await guardrail.listen();
  return { provider, url, sink };
}

const body = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'stub', stream: true, messages: [{ role: 'user', content }], ...extra });

async function post(url: string, payload: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CLIENT_KEY}`,
      ...headers,
    },
    body: payload,
  });
}

// Joins the content of every chunk in an SSE response body.
function contentOf(text: string): string {
  let out = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const chunk = JSON.parse(line.slice(6)) as {
      choices: { delta?: { content?: string } }[];
    };
    out += chunk.choices[0]?.delta?.content ?? '';
  }
  return out;
}

describe('streamed redaction', () => {
  it('redacts PII in the streamed answer and ends with [DONE]', async () => {
    const { url } = await start({ script: () => SAMPLE, chunkSize: 5 });
    const response = await post(url, body('ignored'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(contentOf(text)).toBe(redactText(SAMPLE));
    for (const secret of PII) expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED);
  });

  it('gives the same text whatever the provider chunk size', async () => {
    for (const chunkSize of [1, 2, 3, 7, 19, 64]) {
      const { url } = await start({ script: () => SAMPLE, chunkSize });
      const text = await (await post(url, body('x'))).text();
      expect(contentOf(text), `chunk size ${chunkSize}`).toBe(redactText(SAMPLE));
    }
  });

  it('forwards the gateway provider key, never the client key', async () => {
    const { provider, url } = await start({ script: () => 'hello' });
    await (await post(url, body('hi'))).text();
    expect(provider.lastAuthorization).toBe(`Bearer ${PROVIDER_KEY}`);
  });

  it('sends the first redacted text before the provider finishes (no buffering)', async () => {
    const { url } = await start({
      script: () => 'Hello there, this is a fast answer. '.repeat(4),
      chunkSize: 8,
      delayMs: 150,
    });
    const response = await post(url, body('x'));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    expect(first.done).toBe(false);
    expect(firstAt).toBeLessThan(1000);
    const decoder = new TextDecoder();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value, { stream: true });
    }
    expect(Date.now() - started).toBeGreaterThan(firstAt);
    expect(rest).toContain('[DONE]');
  });

  it('keeps every character when the client reads slowly (backpressure)', async () => {
    const text = 'Slow reader. '.repeat(2000) + SAMPLE;
    const { url, provider } = await start({ script: () => text, chunkSize: 4096 });
    const response = await post(url, body('x'));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      raw += decoder.decode(chunk.value, { stream: true });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(contentOf(raw)).toBe(redactText(text));
    expect(provider.aborted).toBe(0);
  });

  it('keeps the held text bounded for a 10 MB stream', async () => {
    let peak = -1;
    const big = 'a'.repeat(10 * 1024 * 1024) + ' john.doe@example.com';
    const { url } = await start({
      script: () => big,
      chunkSize: 65_536,
      onStats: (stats) => (peak = stats.peakHeld),
    });
    const text = await (await post(url, body('x'))).text();
    expect(peak).toBeGreaterThanOrEqual(0);
    expect(peak).toBeLessThanOrEqual(MAX_HOLDBACK);
    expect(text).not.toContain('john.doe@example.com');
    expect(contentOf(text).length).toBe(redactText(big).length);
  });

  it('stops the provider when the client disconnects', async () => {
    const { url, provider } = await start({
      script: () => 'word '.repeat(5000),
      chunkSize: 4,
      delayMs: 20,
    });
    await new Promise<void>((resolve) => {
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
        },
        (res) => {
          res.once('data', () => req.destroy());
          res.on('error', () => undefined);
        },
      );
      req.on('error', () => undefined);
      req.on('close', () => resolve());
      req.end(body('x'));
    });
    await waitUntil(() => provider.aborted >= 1);
    expect(provider.aborted).toBeGreaterThanOrEqual(1);
  });
});

describe('request validation', () => {
  it.each([
    ['not JSON', '{nope'],
    ['stream false', body('x', { stream: false })],
    ['no messages', JSON.stringify({ model: 'stub', stream: true })],
    ['empty messages', JSON.stringify({ model: 'stub', stream: true, messages: [] })],
  ])('answers 400 for %s', async (_label, payload) => {
    const { url } = await start({ script: () => 'x' });
    const response = await post(url, payload);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_REQUEST',
    );
  });

  it('answers 404 for another path and 405 for another method', async () => {
    const { url } = await start({ script: () => 'x' });
    expect(
      (await fetch(url.replace('/v1/chat/completions', '/nope'), { method: 'POST' })).status,
    ).toBe(404);
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
  });

  it('answers 413 for a body over 1 MiB', async () => {
    const { url } = await start({ script: () => 'x' });
    const response = await post(url, body('a'.repeat(1_100_000)));
    expect(response.status).toBe(413);
  });

  it('forwards only model, messages and stream to the provider', async () => {
    const { url, provider } = await start({ script: (prompt) => prompt });
    await (await post(url, body('hi', { temperature: 0.2, evil: 'x' }))).text();
    expect(provider.lastBody).toEqual({
      model: 'stub',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});

describe('failures', () => {
  it('answers 502 with a fixed message when the provider is unreachable', async () => {
    const { url } = await start({ providerUrl: 'http://127.0.0.1:9/v1/chat/completions' });
    const response = await post(url, body('x'));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe(
      '{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The model provider is unavailable"}}',
    );
    expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|:9/);
  });

  it('logs no prompt, answer, key or provider URL', async () => {
    const { url, sink } = await start({ script: () => SAMPLE });
    await (await post(url, body('secret prompt text'))).text();
    const logged = sink.chunks.join('');
    expect(logged).toContain('"msg":"request"');
    expect(logged).not.toContain('secret prompt text');
    expect(logged).not.toContain(PROVIDER_KEY);
    expect(logged).not.toContain(CLIENT_KEY);
    for (const secret of PII) expect(logged).not.toContain(secret);
  });
});

describe('byte-level splits of the provider stream', () => {
  it('never lets PII through at any byte split of the SSE bytes', async () => {
    const frames = [SAMPLE.slice(0, 20), SAMPLE.slice(20)]
      .map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      .join('');
    const bytes = Buffer.from(frames + 'data: [DONE]\n\n', 'utf8');
    const expected = redactText(SAMPLE);
    for (let cut = 0; cut <= bytes.length; cut++) {
      let content = '';
      const { createStreamingRedactor } = await import('../src/redactor.js');
      const redactor = createStreamingRedactor();
      for await (const payload of sseDataPayloads(
        Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]),
      )) {
        if (payload === '[DONE]') break;
        const parsed = JSON.parse(payload) as { choices: { delta: { content: string } }[] };
        content += redactor.push(parsed.choices[0]!.delta.content);
      }
      content += redactor.flush();
      expect(content, `byte split ${cut}`).toBe(expected);
      for (const secret of PII) expect(content).not.toContain(secret);
    }
  });
});

// A provider that answers with exactly the events the test writes, for shapes the stub never sends.
async function rawProvider(
  events: (res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      events(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('only allowlisted fields reach the client', () => {
  it('redacts nothing it does not forward: tool-call arguments are dropped, never sent in clear', async () => {
    const provider = await rawProvider((res) => {
      res.write(
        encodeEvent({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ function: { arguments: '{"email":"alice@example.com"}' } }] },
              finish_reason: null,
            },
          ],
        }),
      );
      res.write(
        encodeEvent({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      );
      res.end();
    });
    running.push({ close: provider.close } as unknown as StubProvider);
    const { url } = await start({ providerUrl: provider.url });
    const text = await (await post(url, body('x'))).text();
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('tool_calls');
    expect(contentOf(text)).toBe('ok');
  });
});

describe('idle limit mid-stream', () => {
  it('ends a stream whose provider goes silent, without a 502 after the 200', async () => {
    const provider = await rawProvider((res) => {
      res.write(
        encodeEvent({ choices: [{ index: 0, delta: { content: 'part' }, finish_reason: null }] }),
      );
      // Silent from here on: the gateway must end the stream on its own.
    });
    running.push({ close: provider.close } as unknown as StubProvider);
    const { url } = await start({ providerUrl: provider.url, streamIdleMs: 200 });
    const started = Date.now();
    const response = await post(url, body('x'));
    expect(response.status).toBe(200);
    const text = await response.text().catch(() => '');
    expect(text).not.toContain('UPSTREAM_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
