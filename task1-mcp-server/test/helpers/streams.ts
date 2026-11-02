import { PassThrough, Writable } from 'node:stream';
import { LineTransport, type LineTransportOptions } from '../../src/transport.js';

export interface TransportHarness {
  input: PassThrough;
  output: PassThrough;
  transport: LineTransport;
  messages: unknown[];
  outputText: () => string;
  outputLines: () => unknown[];
}

export function createHarness(options: LineTransportOptions = {}): TransportHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const transport = new LineTransport(input, output, options);
  const messages: unknown[] = [];
  transport.onmessage = (message) => messages.push(message);
  const outputText = (): string => Buffer.concat(chunks).toString('utf8');
  const outputLines = (): unknown[] =>
    outputText()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  return { input, output, transport, messages, outputText, outputLines };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
