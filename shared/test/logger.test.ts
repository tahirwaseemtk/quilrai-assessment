import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, parseLogLevel } from '../logger.js';
import { CaptureSink } from './helpers/capture-sink.js';

const fixedNow = () => new Date('2026-11-02T10:00:00.000Z');

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const sink = new CaptureSink();
  const logger = createLogger({ service: 'test-service', sink, level, now: fixedNow });
  const parsed = () => sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
  return { sink, logger, parsed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes one JSON line per call', () => {
    const { sink, logger, parsed } = capture();
    logger.info('started', { pid: 1 });
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]?.endsWith('\n')).toBe(true);
    expect(parsed()).toEqual([
      {
        service: 'test-service',
        time: '2026-11-02T10:00:00.000Z',
        level: 'info',
        msg: 'started',
        pid: 1,
      },
    ]);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('logs level %s', (level) => {
    const { logger, parsed } = capture();
    logger[level]('m');
    expect(parsed()[0]?.level).toBe(level);
  });

  it('filters below the configured level', () => {
    const { logger, parsed } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(parsed().map((entry) => entry.msg)).toEqual(['c', 'd']);
  });

  it('keeps reserved fields from being overwritten', () => {
    const { logger, parsed } = capture();
    logger.info('real', { level: 'fake', msg: 'fake', time: 'fake', service: 'fake' });
    expect(parsed()[0]).toMatchObject({ level: 'info', msg: 'real', service: 'test-service' });
  });

  it('keeps embedded newlines on one physical line', () => {
    const { sink, logger, parsed } = capture();
    logger.info('a\nb', { x: 'c\r\nd' });
    expect(sink.chunks.join('').split('\n')).toHaveLength(2);
    expect(parsed()[0]).toMatchObject({ msg: 'a\nb', x: 'c\r\nd' });
  });

  it('serializes circular objects, bigint and errors without throwing', () => {
    const { logger, parsed } = capture();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const error = new Error('boom');
    expect(() => logger.error('bad', { circular, big: 10n, error })).not.toThrow();
    const entry = parsed()[0];
    expect(entry?.circular).toEqual({ a: 1, self: '[Circular]' });
    expect(entry?.big).toBe('10');
    expect(entry?.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('logs a shared, non-circular object in full each time', () => {
    const { logger, parsed } = capture();
    const shared = { id: 1 };
    logger.info('x', { first: shared, second: shared });
    expect(parsed()[0]).toMatchObject({ first: { id: 1 }, second: { id: 1 } });
  });

  it('keeps the cause of a wrapped error', () => {
    const { logger, parsed } = capture();
    logger.error('x', { error: new Error('outer', { cause: new Error('root') }) });
    expect(parsed()[0]?.error).toMatchObject({
      message: 'outer',
      cause: { name: 'Error', message: 'root' },
    });
  });

  it('defaults to stderr and never writes to stdout', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write');
    createLogger({ service: 'test-service' }).info('to stderr');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('parseLogLevel', () => {
  it.each([
    ['debug', 'debug'],
    ['error', 'error'],
    [undefined, 'info'],
    ['loud', 'info'],
  ])('parses %s as %s', (input, expected) => {
    expect(parseLogLevel(input)).toBe(expected);
  });
});

describe('service tagging', () => {
  it('tags every line with its own service, so tasks sharing a terminal stay distinguishable', () => {
    const sink = new CaptureSink();
    const gateway = createLogger({ service: 'task2-mcp-gateway', sink });
    const mock = createLogger({ service: 'mock-downstream', sink });
    gateway.info('a');
    mock.warn('b');
    gateway.error('c');
    const services = sink.lines().map((line) => (JSON.parse(line) as { service: string }).service);
    expect(services).toEqual(['task2-mcp-gateway', 'mock-downstream', 'task2-mcp-gateway']);
  });

  it('keeps separate loggers independent', () => {
    const quietSink = new CaptureSink();
    const loudSink = new CaptureSink();
    const quiet = createLogger({ service: 'quiet', sink: quietSink, level: 'error' });
    const loud = createLogger({ service: 'loud', sink: loudSink, level: 'debug' });
    quiet.info('hidden');
    loud.debug('shown');
    expect(quietSink.lines()).toEqual([]);
    expect(loudSink.lines()).toHaveLength(1);
  });

  it.each(['', '   '])('refuses an empty service name %j', (service) => {
    expect(() => createLogger({ service })).toThrow('service');
  });
});

describe('redaction', () => {
  const entry = (fields: Record<string, unknown>): Record<string, unknown> => {
    const { logger, parsed } = capture();
    logger.info('m', fields);
    return parsed()[0] ?? {};
  };

  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'cookie',
    'Set-Cookie',
    'set_cookie',
  ])('redacts the %s field', (key) => {
    const line = entry({ [key]: 'Bearer secret-value' });
    expect(line[key]).toBe('[REDACTED]');
    expect(JSON.stringify(line)).not.toContain('secret-value');
  });

  it.each([
    'token',
    'accessToken',
    'refresh_token',
    'id-token',
    'clientSecret',
    'secret_key',
    'PASSWORD',
    'db_password',
    'apikey',
    'apiKey',
    'api_key',
    'API-KEY',
    'x-api-key',
  ])('redacts the secret-named field %s', (key) => {
    expect(entry({ [key]: 'value' })[key]).toBe('[REDACTED]');
  });

  it.each([
    'tokens_used',
    'token_count',
    'key',
    'key_id',
    'monkey',
    'api',
    'pass',
    'auth',
    'keyboard',
    'customer_id',
    'refund_id',
    'amount',
    'reason',
    'tool',
    'path',
    'status',
    'signal',
    'pid',
    'port',
    'url',
  ])('keeps the ordinary field %s', (key) => {
    expect(entry({ [key]: 'kept' })[key]).toBe('kept');
  });

  it('keeps values that merely mention a token', () => {
    expect(entry({ fields: ['DOWNSTREAM_AUTH_TOKEN'] }).fields).toEqual(['DOWNSTREAM_AUTH_TOKEN']);
  });

  it('redacts at any depth and inside arrays', () => {
    const line = entry({
      req: { headers: { authorization: 'Bearer x', host: 'h' } },
      list: [{ token: 't' }, { name: 'n' }],
      a: { b: { c: { d: { password: 'p' } } } },
    });
    expect(line).toMatchObject({
      req: { headers: { authorization: '[REDACTED]', host: 'h' } },
      list: [{ token: '[REDACTED]' }, { name: 'n' }],
      a: { b: { c: { d: { password: '[REDACTED]' } } } },
    });
  });

  it.each([{ nested: 'x' }, 123, null, 10n, ['a']])(
    'replaces a secret value of any type: %s',
    (value) => {
      expect(entry({ token: value }).token).toBe('[REDACTED]');
    },
  );

  it('keeps reserved fields while redacting', () => {
    expect(entry({ level: 'x', msg: 'x', service: 'x', time: 'x', token: 't' })).toMatchObject({
      level: 'info',
      msg: 'm',
      service: 'test-service',
      token: '[REDACTED]',
    });
  });

  it('does not modify the caller object', () => {
    const fields = { authorization: 'Bearer x', nested: { token: 't' } };
    entry(fields);
    expect(fields).toEqual({ authorization: 'Bearer x', nested: { token: 't' } });
  });

  it('redacts inside an error cause', () => {
    const line = entry({ error: new Error('outer', { cause: { authorization: 'x', code: 7 } }) });
    expect(line.error).toMatchObject({
      name: 'Error',
      message: 'outer',
      cause: { authorization: '[REDACTED]', code: 7 },
    });
  });

  it('handles circular and shared objects', () => {
    const circular: Record<string, unknown> = { token: 't' };
    circular.self = circular;
    const shared = { token: 't' };
    const line = entry({ circular, a: shared, b: shared });
    expect(line).toMatchObject({
      circular: { token: '[REDACTED]', self: '[Circular]' },
      a: { token: '[REDACTED]' },
      b: { token: '[REDACTED]' },
    });
    expect(shared.token).toBe('t');
  });

  it('does not scan the message text (call sites must not interpolate secrets)', () => {
    const { logger, parsed } = capture();
    logger.info('Bearer visible');
    expect(parsed()[0]?.msg).toBe('Bearer visible');
  });
});

describe('redaction: review follow-ups', () => {
  const entry = (fields: Record<string, unknown>): Record<string, unknown> => {
    const { logger, parsed } = capture();
    logger.info('m', fields);
    return parsed()[0] ?? {};
  };

  it.each([
    'GATEWAY_TOKENS',
    'authTokens',
    'refresh_tokens',
    'proxy-authorization',
    'Proxy-Authorization',
    'privateKey',
    'private_key',
    'credentials',
    'aws_credential',
    'jwt',
    'bearer',
  ])('redacts %s', (key) => {
    expect(entry({ [key]: 'value' })[key]).toBe('[REDACTED]');
  });

  it.each([
    'tokens',
    'max_tokens',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'input_tokens',
    'output_tokens',
    'reserved_tokens',
    'estimated_tokens',
    'remaining_tokens',
    'used_tokens',
    'cached_tokens',
  ])('keeps the usage count %s', (key) => {
    expect(entry({ [key]: 42 })[key]).toBe(42);
  });

  it('redacts the value after a secret name in name/value lists such as rawHeaders', () => {
    const line = entry({
      rawHeaders: ['Host', 'h', 'Authorization', 'Bearer x', 'Cookie', 'a=b', 'Accept', '*/*'],
    });
    expect(line.rawHeaders).toEqual([
      'Host',
      'h',
      'Authorization',
      '[REDACTED]',
      'Cookie',
      '[REDACTED]',
      'Accept',
      '*/*',
    ]);
  });

  it('does not modify the caller list', () => {
    const rawHeaders = ['Authorization', 'Bearer x'];
    entry({ rawHeaders });
    expect(rawHeaders).toEqual(['Authorization', 'Bearer x']);
  });

  it('detects a circular array', () => {
    const list: unknown[] = ['token', 'value-1'];
    list.push(list);
    expect(entry({ list }).list).toEqual(['token', '[REDACTED]', '[Circular]']);
  });
});

describe('redaction: security review follow-ups', () => {
  const entry = (fields: Record<string, unknown>): Record<string, unknown> => {
    const { logger, parsed } = capture();
    logger.info('m', fields);
    return parsed()[0] ?? {};
  };

  it.each([
    'max_completion_tokens',
    'max_output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'limitTokens',
    'window_tokens',
  ])('keeps the numeric usage count %s', (key) => {
    expect(entry({ [key]: 1200 })[key]).toBe(1200);
    expect(entry({ [key]: 7n })[key]).toBe('7');
  });

  it.each([
    ['a string', 'raw-token'],
    ['an object', { 'raw-token': 'admin' }],
    ['an array', ['raw-token']],
  ])('redacts a tokens field holding %s', (_label, value) => {
    expect(entry({ GATEWAY_TOKENS: value, max_tokens: value }).GATEWAY_TOKENS).toBe('[REDACTED]');
    expect(entry({ max_tokens: value }).max_tokens).toBe('[REDACTED]');
  });

  it.each([
    'authorization_header',
    'authHeader',
    'apiKeys',
    'api_keys',
    'passwd',
    'pwd',
    'sessionid',
    'mcp-session-id',
    'aws_access_key_id',
  ])('redacts %s', (key) => {
    expect(entry({ [key]: 'value' })[key]).toBe('[REDACTED]');
  });

  it.each([
    [new URL('https://user:pass@example.com/x'), 'https://[REDACTED]@example.com/x'],
    ['https://user:pass@example.com/x?q=1', 'https://[REDACTED]@example.com/x?q=1'],
    ['postgres://admin@db:5432/app', 'postgres://[REDACTED]@db:5432/app'],
    ['http://127.0.0.1:8081/mcp', 'http://127.0.0.1:8081/mcp'],
    ['not a url @ all', 'not a url @ all'],
  ])('masks credentials in URL %s', (value, expected) => {
    expect(entry({ url: value }).url).toBe(expected);
  });

  it('falls back to a fixed line instead of throwing on unserializable fields', () => {
    class Recursive {
      toJSON(): unknown {
        return { inner: new Recursive() };
      }
    }
    const throwing = {
      get boom(): string {
        throw new Error('getter failed');
      },
    };
    const { logger, parsed } = capture();
    expect(() => logger.error('first', { value: new Recursive() })).not.toThrow();
    expect(() => logger.error('second', { throwing })).not.toThrow();
    expect(parsed()).toEqual([
      expect.objectContaining({ msg: 'first', level: 'error', log_error: 'unserializable fields' }),
      expect.objectContaining({
        msg: 'second',
        level: 'error',
        log_error: 'unserializable fields',
      }),
    ]);
    expect(Object.keys(parsed()[0] ?? {}).sort()).toEqual(
      ['level', 'log_error', 'msg', 'service', 'time'].sort(),
    );
  });
});
