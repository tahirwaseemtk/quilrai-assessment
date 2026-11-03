import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeEvent, DONE } from '../src/sse.js';

export interface StubProviderOptions {
  // Turns the last user message into the text the provider "generates". Defaults to echoing it.
  script?: (prompt: string) => string;
  // Characters per streamed delta.
  chunkSize?: number;
  // Pause between deltas, in milliseconds.
  delayMs?: number;
}

export interface StubProvider {
  // Authorization header of the most recent request (tests check the gateway's key, not the client's).
  readonly lastAuthorization: string | undefined;
  // Number of streams the provider stopped writing because the gateway closed the connection.
  readonly aborted: number;
  // The JSON body of the most recent request.
  readonly lastBody: unknown;
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const PATH = '/v1/chat/completions';

// A stand-in for an OpenAI-compatible streaming endpoint, for demos and tests. It streams the
// generated text as chat.completion.chunk events, then a finish chunk, then [DONE].
export function createStubProvider(options: StubProviderOptions = {}): StubProvider {
  const script = options.script ?? ((prompt: string) => prompt);
  const chunkSize = options.chunkSize ?? 8;
  const delayMs = options.delayMs ?? 5;
  let lastAuthorization: string | undefined;
  let aborted = 0;
  let lastBody: unknown;

  const server = http.createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== PATH || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    lastAuthorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: { messages: { content: string }[] };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        // A demo tool must not crash on a bad request.
        res.writeHead(400).end();
        return;
      }
      lastBody = body;
      const prompt = body.messages.at(-1)?.content ?? '';
      void stream(res, script(prompt));
    });
  });

  async function stream(res: http.ServerResponse, text: string): Promise<void> {
    let closed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        aborted++;
      }
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let index = 0; index < text.length && !closed; index += chunkSize) {
      const content = text.slice(index, index + chunkSize);
      res.write(
        encodeEvent({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!closed) {
      res.write(
        encodeEvent({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
      );
      res.end(`data: ${DONE}\n\n`);
    }
  }

  return {
    get lastAuthorization() {
      return lastAuthorization;
    },
    get aborted() {
      return aborted;
    },
    get lastBody() {
      return lastBody;
    },
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
