import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, parseLogLevel } from '../src/logger.js';
import { CaptureSink } from './helpers/streams.js';

const fixedNow = () => new Date('2026-11-02T10:00:00.000Z');

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const sink = new CaptureSink();
  const logger = createLogger({ sink, level, now: fixedNow });
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
      { time: '2026-11-02T10:00:00.000Z', level: 'info', msg: 'started', pid: 1 },
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
    logger.info('real', { level: 'fake', msg: 'fake', time: 'fake' });
    expect(parsed()[0]).toMatchObject({ level: 'info', msg: 'real' });
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
    createLogger().info('to stderr');
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
