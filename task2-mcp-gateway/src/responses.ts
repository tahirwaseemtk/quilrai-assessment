import type http from 'node:http';

export const LINGER_MS = 1000;

// Answers with plain text. When the body has not been fully read (401, 413, ...), the complete
// answer is written first, and the rest of the body is discarded (never buffered) for at most
// LINGER_MS before the connection is closed. Closing at once can reset the connection before the
// client reads the answer; draining without a limit would let an unauthenticated client stream a
// chunked body for as long as it likes.
export function sendText(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): number {
  res.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  if (req.complete) {
    res.end(text);
    return status;
  }
  res.write(text);
  const finish = () => {
    clearTimeout(timer);
    if (res.writableEnded) return;
    // A chunked body has no declared end, so Node would keep draining it after the response.
    res.end(() => {
      if (!req.complete) req.socket.destroy();
    });
  };
  const timer = setTimeout(finish, LINGER_MS);
  req.once('end', finish);
  req.once('close', finish);
  req.resume();
  return status;
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): number {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return status;
}
