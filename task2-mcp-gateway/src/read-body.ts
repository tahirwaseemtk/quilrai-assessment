import type { Readable } from 'node:stream';

export const MAX_BODY_BYTES = 1_048_576;

export type BodyResult = { ok: true; bytes: Buffer } | { ok: false };

// Reads at most `limit` bytes. Past the limit it stops reading at once, so an oversized chunked
// body is never buffered. Rejects if the client goes away mid-body.
export function readBody(req: Readable, limit: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve({ ok: true, bytes: Buffer.concat(chunks, size) });
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('request stream failed'));
    };
    const onClose = () => onError(new Error('request closed before the body ended'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// fatal: invalid bytes are a parse error instead of U+FFFD, which a downstream could read
// differently. ignoreBOM: the decoder keeps the BOM, so classifyBody's single strip is the only
// one; the default would strip a second, and a double-BOM body would then pass.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

// The one accepted leading BOM is not forwarded; everything else is forwarded byte for byte.
export function withoutByteOrderMark(bytes: Buffer): Buffer {
  return bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? bytes.subarray(UTF8_BOM.length)
    : bytes;
}
