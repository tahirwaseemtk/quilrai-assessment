import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineTransport, MAX_LINE_BYTES } from '../src/transport.js';
import { createHarness, flush } from './helpers/streams.js';

const ping = (id: number | string): string =>
  `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"ping"}`;
const invalidRequest = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'Invalid Request' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LineTransport framing', () => {
  it('assembles one message from single-byte chunks', async () => {
    const { input, transport, messages } = createHarness();
    await transport.start();
    for (const byte of Buffer.from(`${ping(1)}\n`)) input.write(Buffer.from([byte]));
    await flush();
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  });

  it('decodes multibyte text split at every byte position', async () => {
    const line = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"note":"café 😀"}}\n',
    );
    for (let i = 1; i < line.length; i += 1) {
      const { input, transport, messages } = createHarness();
      await transport.start();
      input.write(line.subarray(0, i));
      input.write(line.subarray(i));
      await flush();
      expect(messages, `split at ${i}`).toHaveLength(1);
      expect((messages[0] as { params: { note: string } }).params.note).toBe('café 😀');
    }
  });

  it('delivers several messages from one chunk in order', async () => {
    const { input, transport, messages } = createHarness();
    await transport.start();
    input.write(`${ping(1)}\n${ping(2)}\n${ping(3)}\n`);
    await flush();
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it('accepts CRLF framing and keeps an escaped CR inside strings', async () => {
    const { input, transport, messages } = createHarness();
    await transport.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"s":"a\\rb"}}\r\n');
    await flush();
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping', params: { s: 'a\rb' } }]);
  });

  it.each(['\n', '\r\n', '\n\n\n', '   \n'])('ignores blank line %j', async (text) => {
    const { input, transport, messages, outputText } = createHarness();
    await transport.start();
    input.write(text);
    await flush();
    expect(messages).toEqual([]);
    expect(outputText()).toBe('');
  });

  it('replies -32700 to a malformed line and keeps reading', async () => {
    const { input, transport, messages, outputLines } = createHarness();
    await transport.start();
    input.write(`{bad json\n${ping(2)}\n`);
    await flush();
    expect(outputLines()).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
  });

  it('writes nothing for dropped input', async () => {
    const { input, transport, messages, outputText } = createHarness();
    await transport.start();
    input.write('{"jsonrpc":"2.0","method":"notifications/x","params":"bad"}\n');
    await flush();
    expect(messages).toEqual([]);
    expect(outputText()).toBe('');
  });

  it('replaces invalid UTF-8 bytes instead of failing', async () => {
    const { input, transport, messages } = createHarness();
    await transport.start();
    input.write(
      Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"s":"'),
        Buffer.from([0xff]),
        Buffer.from('"}}\n'),
      ]),
    );
    await flush();
    expect((messages[0] as { params: { s: string } }).params.s).toBe('�');
  });
});

describe('LineTransport line size limit', () => {
  const paddedPing = (totalBytes: number): string => {
    const base = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":""}}';
    return base.replace('"pad":""', `"pad":"${'x'.repeat(totalBytes - base.length)}"`);
  };

  it('delivers a line of exactly the maximum size', async () => {
    const { input, transport, messages, outputText } = createHarness();
    await transport.start();
    input.write(`${paddedPing(MAX_LINE_BYTES)}\n`);
    await flush();
    expect(messages).toHaveLength(1);
    expect(outputText()).toBe('');
  });

  it('rejects a line one byte over the maximum with one -32600', async () => {
    const { input, transport, messages, outputLines } = createHarness();
    await transport.start();
    input.write(`${paddedPing(MAX_LINE_BYTES + 1)}\n`);
    await flush();
    expect(messages).toEqual([]);
    expect(outputLines()).toEqual([invalidRequest]);
  });

  it('discards the rest of an oversize line, then recovers', async () => {
    const { input, transport, messages, outputLines } = createHarness();
    await transport.start();
    const chunk = Buffer.alloc(64 * 1024, 'y');
    for (let i = 0; i < 48; i += 1) input.write(chunk);
    input.write(`\n${ping(9)}\n`);
    await flush();
    expect(outputLines()).toEqual([invalidRequest]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
  });

  it('replies before the newline arrives, keeping the buffer bounded', async () => {
    const { input, transport, outputLines } = createHarness();
    await transport.start();
    input.write(Buffer.alloc(MAX_LINE_BYTES + 1, 'z'));
    await flush();
    expect(outputLines()).toEqual([invalidRequest]);
  });

  it('does not count a trailing CR toward the limit', async () => {
    const { input, transport, messages, outputText } = createHarness();
    await transport.start();
    input.write(`${paddedPing(MAX_LINE_BYTES)}\r\n`);
    await flush();
    expect(messages).toHaveLength(1);
    expect(outputText()).toBe('');
  });

  it('handles a multibyte character straddling the limit', async () => {
    const { input, transport, messages, outputLines } = createHarness();
    await transport.start();
    const line = Buffer.concat([Buffer.alloc(MAX_LINE_BYTES - 2, 'a'), Buffer.from('😀')]);
    input.write(line);
    input.write(`\n${ping(3)}\n`);
    await flush();
    expect(outputLines()).toEqual([invalidRequest]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 3, method: 'ping' }]);
  });
});

describe('LineTransport send', () => {
  it('writes exactly one newline-terminated line per message', async () => {
    const { transport, outputText } = createHarness();
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, result: { t: 'a\nb ' } });
    const text = outputText();
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: 1, result: { t: 'a\nb ' } });
  });

  it('sanitizes error messages before writing', async () => {
    const { transport, outputLines } = createHarness();
    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'ZodError: secret' },
    });
    expect(outputLines()).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } },
    ]);
  });

  it('waits for drain under backpressure and keeps order', async () => {
    const callbacks: (() => void)[] = [];
    const written: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString('utf8'));
        callbacks.push(callback);
      },
    });
    const { input } = createHarness();
    const transport = new LineTransport(input, output);
    await transport.start();
    let firstDone = false;
    const first = transport.send({ jsonrpc: '2.0', id: 1, result: {} }).then(() => {
      firstDone = true;
    });
    const second = transport.send({ jsonrpc: '2.0', id: 2, result: {} });
    await flush();
    expect(firstDone).toBe(false);
    while (callbacks.length > 0) {
      callbacks.shift()?.();
      await flush();
    }
    await Promise.all([first, second]);
    expect(written.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2]);
  });

  it('shares one drain listener across sends waiting on backpressure', async () => {
    const callbacks: (() => void)[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callbacks.push(callback);
      },
    });
    const { input } = createHarness();
    const transport = new LineTransport(input, output);
    await transport.start();
    const sends = Array.from({ length: 20 }, (_, id) =>
      transport.send({ jsonrpc: '2.0', id, result: {} }),
    );
    await flush();
    expect(output.listenerCount('drain')).toBe(1);
    while (callbacks.length > 0) {
      callbacks.shift()?.();
      await flush();
    }
    await Promise.all(sends);
    expect(output.listenerCount('drain')).toBe(0);
  });

  it('rejects and reports a write error without touching process.stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });
    const { input } = createHarness();
    const transport = new LineTransport(input, output);
    const onerror = vi.fn();
    transport.onerror = onerror;
    await transport.start();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow('EPIPE');
    await flush();
    expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'EPIPE' }));
    expect(stdout).not.toHaveBeenCalled();
  });

  it('rejects sends still waiting on backpressure when the transport closes', async () => {
    const output = new Writable({
      highWaterMark: 1,
      write() {
        // never completes, so the stream stays full
      },
    });
    const { input } = createHarness();
    const transport = new LineTransport(input, output);
    await transport.start();
    const pending = transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    await flush();
    await transport.close();
    await expect(pending).rejects.toThrow('closed');
    expect(output.listenerCount('drain')).toBe(0);
  });

  it('rejects send after close and writes nothing', async () => {
    const { transport, outputText } = createHarness();
    await transport.start();
    await transport.close();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow();
    expect(outputText()).toBe('');
  });
});

describe('LineTransport lifecycle', () => {
  it('rejects a second start', async () => {
    const { transport } = createHarness();
    await transport.start();
    await expect(transport.start()).rejects.toThrow();
  });

  it('closes idempotently and removes its input listeners', async () => {
    const { input, transport } = createHarness();
    const baseline = input.listenerCount('data');
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    await transport.close();
    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(input.listenerCount('data')).toBe(baseline);
  });

  it('closes once input ends with nothing in flight', async () => {
    const { input, transport } = createHarness();
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    input.end();
    await flush();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('answers requests in flight at input end before closing', async () => {
    const { input, transport, outputLines } = createHarness();
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.onmessage = (message) => {
      setTimeout(() => {
        void transport.send({ jsonrpc: '2.0', id: (message as { id: number }).id, result: {} });
      }, 20);
    };
    await transport.start();
    input.end(`${ping(1)}\n`);
    await flush();
    expect(onclose).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(outputLines()).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('keeps a request in flight when an error reply reuses its id', async () => {
    const { input, transport, outputLines } = createHarness();
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.onmessage = () => undefined;
    await transport.start();
    input.end(`${ping(1)}\n{"jsonrpc":"2.0","id":1}\n`);
    await flush();
    expect(outputLines()).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } },
    ]);
    expect(onclose).not.toHaveBeenCalled();
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('counts requests that share an id separately', async () => {
    const { input, transport } = createHarness();
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.onmessage = () => undefined;
    await transport.start();
    input.end(`${ping(1)}\n${ping(1)}\n`);
    await flush();
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(onclose).not.toHaveBeenCalled();
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('releases a request cancelled by the client', async () => {
    const { input, transport } = createHarness();
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.onmessage = () => undefined;
    await transport.start();
    input.end(
      `${ping(5)}\n{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":5}}\n`,
    );
    await flush();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('releases the request and closes when the response write fails', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });
    const { input } = createHarness();
    const transport = new LineTransport(input, output);
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.onerror = () => undefined;
    transport.onmessage = () => undefined;
    await transport.start();
    input.end(`${ping(1)}\n`);
    await flush();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow('EPIPE');
    await flush();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('processes an unterminated final line when input ends', async () => {
    const { input, transport, messages } = createHarness();
    await transport.start();
    input.end(ping(1));
    await flush();
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  });

  it('ignores input after close', async () => {
    const { input, transport, messages, outputText } = createHarness();
    await transport.start();
    await transport.close();
    input.write(`${ping(1)}\n{bad\n`);
    await flush();
    expect(messages).toEqual([]);
    expect(outputText()).toBe('');
  });

  it('reports an input stream error and closes once', async () => {
    const { input, transport } = createHarness();
    const onerror = vi.fn();
    const onclose = vi.fn();
    transport.onerror = onerror;
    transport.onclose = onclose;
    await transport.start();
    input.destroy(new Error('x'));
    await flush();
    expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'x' }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
