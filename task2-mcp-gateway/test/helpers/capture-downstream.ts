import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  path: string;
  rawHeaders: string[];
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Responder = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  captured: CapturedRequest,
) => unknown;

export interface CaptureDownstream {
  url: string;
  requests: CapturedRequest[];
  respond(responder: Responder): void;
  close(): Promise<void>;
}

const defaultResponder: Responder = (_req, res) => {
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end('{"jsonrpc":"2.0","id":1,"result":{}}');
};

// A plain HTTP server that records the exact bytes and headers the gateway sends, so tests can
// assert byte-level forwarding without an MCP server's parsing in between.
export async function startCaptureDownstream(): Promise<CaptureDownstream> {
  const requests: CapturedRequest[] = [];
  let responder = defaultResponder;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        rawHeaders: req.rawHeaders,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      Promise.resolve(responder(req, res, captured)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    respond(next) {
      responder = next;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
