import type { Readable, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, errorResponse } from './errors.js';
import { classifyInbound } from './inbound.js';
import { sanitizeOutbound } from './outbound.js';

export const MAX_LINE_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface LineTransportOptions {
  maxLineBytes?: number;
}

// Replaces the SDK StdioServerTransport, which drops malformed lines without replying
// (no -32700 / -32600) and closes itself when its read buffer overflows. See ADR 013.
export class LineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly maxLineBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private discarding = false;
  private started = false;
  private closed = false;
  private inputEnded = false;
  private drain: { promise: Promise<void>; cancel: (error: Error) => void } | undefined;
  // Counted per id: clients may (wrongly) reuse ids, and each request still needs its answer.
  private readonly inFlight = new Map<RequestId, number>();

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    options: LineTransportOptions = {},
  ) {
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  start(): Promise<void> {
    if (this.started) return Promise.reject(new Error('LineTransport already started'));
    this.started = true;
    this.input.on('data', this.onData);
    this.input.on('end', this.onEnd);
    this.input.on('error', this.onInputError);
    this.output.on('error', this.onOutputError);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    const write = this.write(message);
    if ('method' in message || !('id' in message) || message.id === undefined) return write;
    const { id } = message;
    return write.finally(() => this.release(id));
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('error', this.onInputError);
    this.output.off('error', this.onOutputError);
    if (this.input.listenerCount('data') === 0) this.input.pause();
    this.drain?.cancel(new Error('LineTransport is closed'));
    this.pending = [];
    this.pendingBytes = 0;
    this.onclose?.();
    return Promise.resolve();
  }

  private write(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('LineTransport is closed'));
    const line = `${JSON.stringify(sanitizeOutbound(message))}\n`;

    return new Promise<void>((resolve, reject) => {
      const accepted = this.output.write(line, (error) => {
        if (error) reject(error);
      });
      if (accepted) resolve();
      else this.waitForDrain().then(resolve, reject);
    });
  }

  // One shared drain listener for all sends blocked on backpressure; close() rejects them.
  private waitForDrain(): Promise<void> {
    if (!this.drain) {
      let cancel: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          this.drain = undefined;
          resolve();
        };
        this.output.once('drain', onDrain);
        cancel = (error) => {
          this.output.off('drain', onDrain);
          this.drain = undefined;
          reject(error);
        };
      });
      this.drain = { promise, cancel };
    }
    return this.drain.promise;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    let data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let newline = data.indexOf(NEWLINE);

    while (newline !== -1 && !this.closed) {
      const segment = data.subarray(0, newline);
      if (this.discarding) {
        this.discarding = false;
      } else if (this.lineBytes(segment) > this.maxLineBytes) {
        this.rejectOversize();
      } else {
        this.handleLine(Buffer.concat([...this.pending, segment]));
      }
      this.pending = [];
      this.pendingBytes = 0;
      data = data.subarray(newline + 1);
      newline = data.indexOf(NEWLINE);
    }

    if (this.discarding || this.closed || data.length === 0) return;
    const buffered = this.pendingBytes + data.length;
    // A max-size line may still be followed by the CR of a CRLF terminator.
    const overLimit =
      buffered > this.maxLineBytes + 1 ||
      (buffered === this.maxLineBytes + 1 && data.at(-1) !== CARRIAGE_RETURN);
    if (overLimit) {
      // Reply as soon as the limit is crossed so the buffer never holds more than one max line.
      this.rejectOversize();
      this.discarding = true;
      this.pending = [];
      this.pendingBytes = 0;
      return;
    }
    this.pending.push(data);
    this.pendingBytes += data.length;
  };

  // Payload size of a completed line, excluding a trailing CR from CRLF framing.
  private lineBytes(segment: Buffer): number {
    const total = this.pendingBytes + segment.length;
    const last = segment.length > 0 ? segment.at(-1) : this.pending.at(-1)?.at(-1);
    return last === CARRIAGE_RETURN ? total - 1 : total;
  }

  private readonly onEnd = (): void => {
    if (!this.discarding && this.pendingBytes > 0) {
      this.handleLine(Buffer.concat(this.pending));
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.inputEnded = true;
    this.closeIfDrained();
  };

  private readonly onInputError = (error: Error): void => {
    this.onerror?.(error);
    void this.close();
  };

  // A failed stdout write means the client is gone; nothing more can be delivered.
  private readonly onOutputError = (error: Error): void => {
    this.onerror?.(error);
    void this.close();
  };

  private handleLine(bytes: Buffer): void {
    const text = bytes.toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return;

    const result = classifyInbound(text);
    if (result.kind === 'reply') {
      void this.write(result.response).catch(() => undefined);
    } else if (result.kind === 'message') {
      this.track(result.message);
      this.onmessage?.(result.message);
    }
  }

  private track(message: JSONRPCMessage): void {
    if (!('method' in message)) return;
    if ('id' in message) {
      this.inFlight.set(message.id, (this.inFlight.get(message.id) ?? 0) + 1);
    } else if (message.method === 'notifications/cancelled') {
      // The SDK sends no response for a cancelled request, so release it here.
      const requestId = message.params?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') this.release(requestId);
    }
  }

  private release(id: RequestId): void {
    const count = this.inFlight.get(id);
    if (count === undefined) return;
    if (count <= 1) this.inFlight.delete(id);
    else this.inFlight.set(id, count - 1);
    this.closeIfDrained();
  }

  private rejectOversize(): void {
    void this.write(errorResponse(null, ErrorCode.InvalidRequest)).catch(() => undefined);
  }

  // Input end means no more requests, not that answers are no longer wanted: close only once
  // every request read before the end has been answered or cancelled.
  private closeIfDrained(): void {
    if (this.inputEnded && this.inFlight.size === 0) void this.close();
  }
}
