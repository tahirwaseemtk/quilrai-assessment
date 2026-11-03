import http from 'node:http';
import net from 'node:net';

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

// Wider than http.OutgoingHttpHeaders, which types some headers (authorization) as one string.
export type RawHeaders = Record<string, string | string[] | number>;

export interface RawRequestOptions {
  port: number;
  path?: string;
  method?: string;
  headers?: RawHeaders;
  body?: Buffer | string;
  chunks?: Buffer[];
}

// http.request sends array header values as repeated headers and keeps odd paths, which fetch
// would normalize away.
export function rawRequest(options: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: options.headers ?? {},
        // A fresh connection per request: a pooled socket could still owe the server a body.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.chunks) {
      for (const chunk of options.chunks) req.write(chunk);
      req.end();
    } else {
      req.end(options.body);
    }
  });
}

// Sends a raw request line, for request-targets that http.request would reject or rewrite.
export function rawSocketRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let response = '';
    socket.on('data', (chunk: Buffer) => (response += chunk.toString('utf8')));
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(response);
    });
  });
}
