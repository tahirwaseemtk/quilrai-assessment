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

const REDACTED = '[REDACTED]';
const SECRET_KEYS = new Set(['cookie', 'setcookie', 'jwt', 'bearer', 'pwd', 'authheader']);
const SECRET_PARTS = [
  'authorization',
  'secret',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'accesskey',
  'session',
];
const SECRET_SUFFIXES = ['token', 'apikey', 'apikeys'];
// Userinfo in a URL ("scheme://user:pass@host"); bounded classes keep this linear.
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/i;

type KeyKind = 'secret' | 'count' | 'plain';

// A safety net, not the primary control: call sites should not log credentials at all. Keys are
// compared lowercased without "-" or "_". A key ending in "tokens" is a usage count when its value
// is a number (max_tokens, cache_read_input_tokens, ...) and is redacted otherwise, which catches
// credential tables such as GATEWAY_TOKENS without hiding Task 4's counts.
function classifyKey(key: string): KeyKind {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (SECRET_KEYS.has(normalized)) return 'secret';
  if (SECRET_PARTS.some((part) => normalized.includes(part))) return 'secret';
  if (SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'secret';
  return normalized.endsWith('tokens') ? 'count' : 'plain';
}

export function isSecretKey(key: string): boolean {
  return classifyKey(key) !== 'plain';
}

const isCount = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint';

// Name/value lists such as Node's req.rawHeaders: the value after a secret name is redacted.
function redactPairs(list: readonly unknown[]): unknown[] {
  return list.map((item, index) => {
    const previous = list[index - 1];
    return typeof previous === 'string' && isSecretKey(previous) ? REDACTED : item;
  });
}

function serialize(entry: LogFields): string {
  // Only objects on the current path count as circular; a shared object is logged in full.
  // Each ancestor keeps the original object (for cycle detection) and the object actually
  // serialized in its place (JSON.stringify's `this` for its children).
  const ancestors: { original: unknown; serialized: unknown }[] = [];
  return JSON.stringify(entry, function (this: unknown, key, value: unknown) {
    const kind = classifyKey(key);
    if (kind === 'secret' || (kind === 'count' && !isCount(value))) return REDACTED;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') return value.replace(URL_USERINFO, `$1${REDACTED}@`);
    if (typeof value !== 'object' || value === null) return value;

    while (ancestors.length > 0 && ancestors.at(-1)?.serialized !== this) ancestors.pop();
    if (ancestors.some((ancestor) => ancestor.original === value)) return '[Circular]';

    const serialized =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : Array.isArray(value)
          ? redactPairs(value)
          : value;
    ancestors.push({ original: value, serialized });
    return serialized;
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
    const time = now().toISOString();
    let line: string;
    try {
      line = serialize({ ...fields, service, time, level, msg });
    } catch {
      // Logging must never throw, least of all on an error path; no field content is kept.
      line = JSON.stringify({ service, time, level, msg, log_error: 'unserializable fields' });
    }
    sink.write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
