import { Writable } from 'node:stream';

// Collects everything written, for asserting on log output in tests.
export class CaptureSink extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk.toString('utf8'));
    callback();
  }

  lines(): string[] {
    return this.chunks.join('').split('\n').filter(Boolean);
  }
}
