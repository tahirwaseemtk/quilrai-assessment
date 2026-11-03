import { timingSafeEqual } from 'node:crypto';
import util from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { authenticate, constantTimeEqual } from '../src/auth.js';

// Tests write single headers as strings; the function only accepts headersDistinct arrays.
const h = (value: string | string[] | undefined): string[] | undefined =>
  typeof value === 'string' ? [value] : value;
import { parseTokenConfig, type TokenTable } from '../src/token-config.js';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const ADMIN = 'adm-Tok.1-long-enough';
const VIEWER = 'view_tok~2-long-enough';

function table(entries: Record<string, string>): TokenTable {
  const result = parseTokenConfig(JSON.stringify(entries));
  if (!result.ok) throw new Error(result.reason);
  return result.table;
}

const roles = table({ [ADMIN]: 'admin', [VIEWER]: 'viewer', secret: 'viewer' });

function countingComparator() {
  return vi.fn((a: Buffer, b: Buffer) => {
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    return timingSafeEqual(a, b);
  });
}

describe('authenticate: accepted', () => {
  it.each([
    [`Bearer ${ADMIN}`, 'admin'],
    [`Bearer ${VIEWER}`, 'viewer'],
    [`bearer ${ADMIN}`, 'admin'],
    [`BEARER ${ADMIN}`, 'admin'],
    [[`Bearer ${ADMIN}`], 'admin'],
  ])('maps %j to %s', (header, role) => {
    expect(authenticate(h(header), roles)).toEqual({ ok: true, role });
  });
});

describe('authenticate: refused', () => {
  it.each([undefined, [], '', ['']])('reports %j as missing', (header) => {
    expect(authenticate(h(header), roles)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    'Bearer',
    'Bearer ',
    'Basic YWRtOng=',
    `Token ${ADMIN}`,
    `Bearer  ${ADMIN}`,
    `Bearer ${ADMIN} `,
    `Bearer\t${ADMIN}`,
    'Bearer a b',
    `Bearer ${ADMIN},Bearer x`,
    ADMIN,
    `Bearer ${char(0x455)}ecret`,
    `Bearer ${ADMIN}${char(0x200b)}`,
    ['Basic x'],
  ])('reports %j as malformed', (header) => {
    expect(authenticate(h(header), roles)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    'Bearer nope',
    `Bearer ${ADMIN.slice(0, -1)}`,
    `Bearer ${ADMIN}x`,
    `Bearer ${ADMIN.toUpperCase()}`,
    `Bearer ${'a'.repeat(10_000)}`,
    'Bearer __proto__',
    ['Bearer nope'],
  ])('reports %j as unknown', (header) => {
    expect(authenticate(h(header), roles)).toEqual({ ok: false, reason: 'unknown' });
  });

  it.each([
    [[`Bearer ${ADMIN}`, `Bearer ${ADMIN}`]],
    [[`Bearer ${VIEWER}`, `Bearer ${ADMIN}`]],
    [[`Bearer ${ADMIN}`, `Bearer ${VIEWER}`]],
    [['Basic x', `Bearer ${ADMIN}`]],
    [['', '']],
  ])('reports duplicate Authorization headers %j before anything else', (header) => {
    expect(authenticate(h(header), roles)).toEqual({ ok: false, reason: 'duplicate' });
  });
});

describe('authenticate: constant-time comparison', () => {
  const five = table({
    'token-zero-long-enough': 'admin',
    'token-one-long-enough': 'viewer',
    'token-two-long-enough': 'viewer',
    'token-three-long-enough': 'viewer',
    'token-four-long-enough': 'admin',
  });

  it.each([
    ['the first entry', 'Bearer token-zero-long-enough', { ok: true, role: 'admin' }],
    ['the last entry', 'Bearer token-four-long-enough', { ok: true, role: 'admin' }],
    ['no entry', 'Bearer token-none-long-enough', { ok: false, reason: 'unknown' }],
  ])('compares against every entry when the match is %s', (_label, header, expected) => {
    const compare = countingComparator();
    expect(authenticate(h(header), five, compare)).toEqual(expected);
    expect(compare).toHaveBeenCalledTimes(5);
  });

  it.each([undefined, 'Basic x', ['Bearer a', 'Bearer b']])(
    'makes no comparison for %j',
    (header) => {
      const compare = countingComparator();
      authenticate(h(header), five, compare);
      expect(compare).not.toHaveBeenCalled();
    },
  );

  it('uses timingSafeEqual by default', () => {
    expect(constantTimeEqual).toBe(timingSafeEqual);
    expect(authenticate(['Bearer token-zero-long-enough'], five)).toEqual({
      ok: true,
      role: 'admin',
    });
  });

  it('does not change the table across many calls', () => {
    const before = util.inspect(roles, { depth: Infinity });
    for (let i = 0; i < 100; i += 1) {
      expect(authenticate([`Bearer ${i % 2 ? ADMIN : VIEWER}`], roles)).toEqual({
        ok: true,
        role: i % 2 ? 'admin' : 'viewer',
      });
    }
    expect(util.inspect(roles, { depth: Infinity })).toBe(before);
  });
});
