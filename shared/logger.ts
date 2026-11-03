import type { Writable } from 'node:stream';
import { z } from 'zod';

const levels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof levels)[number];
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  // Tags every line, so output from tasks and stubs sharing a terminal stays distinguishable.
  service: string;
  sink?: Writable;
  level?: LogLevel;
  now?: () => Date;
}

const logLevelSchema = z.enum(levels).catch('info');

export function parseLogLevel(value: string | undefined): LogLevel {
  return logLevelSchema.parse(value);
}

function serialize(entry: LogFields): string {
  // Only objects on the current path count as circular; a shared object is logged in full.
  const ancestors: unknown[] = [];
  return JSON.stringify(entry, function (this: unknown, _key, value: unknown) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null) return value;

    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[Circular]';

    const replaced =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value;
    ancestors.push(replaced);
    return replaced;
  });
}

// Writes to stderr by default: in the stdio server, stdout carries JSON-RPC only. Each task
// creates its own instance; there is no shared global logger.
export function createLogger(options: LoggerOptions): Logger {
  const service = options.service.trim();
  if (service === '') throw new Error('Logger service name must not be empty');
  const sink = options.sink ?? process.stderr;
  const threshold = levels.indexOf(options.level ?? 'info');
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (levels.indexOf(level) < threshold) return;
    const line = serialize({ ...fields, service, time: now().toISOString(), level, msg });
    sink.write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
