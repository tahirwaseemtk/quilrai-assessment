import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// How a stub answers: success, a status code, a request that never finishes, or a dropped socket.
export type StubBehavior =
  { kind: 'ok' } | { kind: 'status'; status: number } | { kind: 'hang' } | { kind: 'reset' };

export interface StubProvider {
  readonly requests: number;
  readonly lastAuthorization: string | undefined;
  setBehavior(behavior: StubBehavior): void;
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

function maxTokensOf(body: string): number {
  try {
    const value = (JSON.parse(body) as { max_tokens?: unknown }).max_tokens;
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

// A stand-in for an OpenAI-compatible completions endpoint, for demos and failover tests.
export function createStubProvider(initial: StubBehavior = { kind: 'ok' }): StubProvider {
  let behavior = initial;
  let requests = 0;
  let lastAuthorization: string | undefined;
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    requests++;
    lastAuthorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (behavior.kind === 'hang') return;
      if (behavior.kind === 'reset') {
        req.socket.destroy();
        return;
      }
      if (behavior.kind === 'status') {
        res
          .writeHead(behavior.status, { 'content-type': 'text/plain' })
          .end('provider internal detail');
        return;
      }
      // The stub reports the output it was asked for, so the router's settlement is predictable.
      const requested = maxTokensOf(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          object: 'text_completion',
          choices: [{ text: 'stub answer' }],
          usage: { prompt_tokens: 3, completion_tokens: requested, total_tokens: requested },
        }),
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    get requests() {
      return requests;
    },
    get lastAuthorization() {
      return lastAuthorization;
    },
    setBehavior(next) {
      behavior = next;
    },
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const { port: bound } = server.address() as AddressInfo;
          resolve({ url: `http://${HOST}:${bound}/v1/completions`, port: bound });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}
