import { createHash } from 'node:crypto';
import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../src/auth.js';
import {
  TokenConfigError,
  TokenConfigWarning,
  parseTokenConfig,
  type TokenTable,
} from '../src/token-config.js';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const ADMIN = 'adm-Tok.1-long-enough';
const VIEWER = 'view_tok~2-long-enough';
const config = (entries: Record<string, unknown>): string => JSON.stringify(entries);
const cfg = config({ [ADMIN]: 'admin', [VIEWER]: 'viewer' });

function expectTable(raw: string | undefined): TokenTable {
  const result = parseTokenConfig(raw);
  if (!result.ok) throw new Error(`expected a valid config, got ${result.reason}`);
  return result.table;
}

function expectRejected(raw: string | undefined, reason: string): void {
  const result = parseTokenConfig(raw);
  expect(result).toEqual({ ok: false, reason });
  expect(Object.values(TokenConfigError)).toContain(reason);
}

describe('parseTokenConfig: valid configs', () => {
  it('reads a single entry', () => {
    const table = expectTable(config({ [ADMIN]: 'admin' }));
    expect(authenticate([`Bearer ${ADMIN}`], table)).toEqual({ ok: true, role: 'admin' });
  });

  it.each([
    [ADMIN, 'admin'],
    [VIEWER, 'viewer'],
    ['third-token-long-enough', 'viewer'],
  ])('maps %s to %s among several entries', (token, role) => {
    const table = expectTable(
      config({ [ADMIN]: 'admin', [VIEWER]: 'viewer', 'third-token-long-enough': 'viewer' }),
    );
    expect(authenticate([`Bearer ${token}`], table)).toEqual({ ok: true, role });
  });

  it.each(['dG9rZW4tdG9rZW4tdG9r==', 'a.b_c~d+e/f-g-long-enough', 'x', 'a'.repeat(4096)])(
    'accepts the token68 edge case %j',
    (token) => {
      const table = expectTable(config({ [token]: 'viewer' }));
      expect(authenticate([`Bearer ${token}`], table)).toEqual({ ok: true, role: 'viewer' });
    },
  );

  it('treats __proto__ as a literal token without polluting Object.prototype', () => {
    const table = expectTable('{"__proto__":"admin"}');
    expect(authenticate(['Bearer __proto__'], table)).toEqual({ ok: true, role: 'admin' });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  it('maps prototype-named tokens when they are configured', () => {
    const table = expectTable('{"constructor":"viewer","toString":"admin"}');
    expect(authenticate(['Bearer constructor'], table)).toEqual({ ok: true, role: 'viewer' });
    expect(authenticate(['Bearer toString'], table)).toEqual({ ok: true, role: 'admin' });
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not inherit %s from the prototype',
    (token) => {
      expect(authenticate([`Bearer ${token}`], expectTable(cfg))).toEqual({
        ok: false,
        reason: 'unknown',
      });
    },
  );

  it('handles 10,000 entries', () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 10_000; i += 1) entries[`token-number-${i}`] = i % 2 ? 'admin' : 'viewer';
    const table = expectTable(config(entries));
    expect(authenticate(['Bearer token-number-9999'], table)).toEqual({ ok: true, role: 'admin' });
  });
});

describe('parseTokenConfig: rejected configs', () => {
  it.each([undefined, '', '   ', '\n'])('requires a value, rejecting %j', (raw) => {
    expectRejected(raw, TokenConfigError.Required);
  });

  it.each([
    '{',
    '{"a":"admin",}',
    "{'a':'admin'}",
    'null',
    '[]',
    '[["a","admin"]]',
    '"tok"',
    '1',
    'true',
  ])('requires a JSON object, rejecting %s', (raw) => {
    expectRejected(raw, TokenConfigError.NotObject);
    expect(TokenConfigError.NotObject).not.toContain('SyntaxError');
  });

  it.each([
    '{"dup-token-long-enough":"viewer","dup-token-long-enough":"admin"}',
    '{"dup-token-long-enough":"admin","other-token-long-enough":"viewer","dup-token-long-enough":"viewer"}',
    '{ "dup-token-long-enough" : "admin", "dup-token-long-enough":"admin" }',
  ])('rejects a duplicated token, which would silently change its role: %s', (raw) => {
    expectRejected(raw, TokenConfigError.Duplicate);
  });

  it('does not mistake an escaped quote for a second key', () => {
    expect(parseTokenConfig('{"tok-escaped-long-enough":"admin"}')).toMatchObject({ ok: true });
    expectRejected('{"tok-a-long-enough-xx":"ad\\\":min"}', TokenConfigError.InvalidRole);
  });

  it('requires at least one token', () => {
    expectRejected('{}', TokenConfigError.Empty);
  });

  it.each(['Admin', 'ADMIN', ' admin', 'root', '', null, 1, true, ['admin'], { role: 'admin' }])(
    'rejects the role %j',
    (role) => {
      expectRejected(config({ 'some-token-long-enough': role }), TokenConfigError.InvalidRole);
    },
  );

  it('rejects the whole config when one entry is bad', () => {
    expectRejected(
      config({ 'good-token-long-enough': 'admin', 'bad-token-long-enough': 'owner' }),
      TokenConfigError.InvalidRole,
    );
  });

  it.each([
    '',
    'a b',
    'to=k',
    'tok;x',
    `tok${char(0x200b)}`,
    `${char(0x455)}ecret`,
    `tok${char(0xa0)}`,
    ' tok',
    'tok\n',
  ])('rejects the token %j', (token) => {
    expectRejected(config({ [token]: 'admin' }), TokenConfigError.InvalidToken);
  });

  it('never echoes a configured token in the reason', () => {
    const secret = 'super-secret-token-value';
    for (const raw of [config({ [secret]: 'owner' }), config({ [`${secret} x`]: 'admin' })]) {
      const result = parseTokenConfig(raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('super-secret');
    }
  });
});

describe('parseTokenConfig: warnings', () => {
  it.each([
    [
      'the .env.example placeholders',
      config({ 'replace-with-admin-token': 'admin', 'replace-with-viewer-token': 'viewer' }),
    ],
    ['a short token', config({ tiny1: 'admin', [VIEWER]: 'viewer' })],
    ['a placeholder in another case', config({ 'Replace-With-Admin-Token-x': 'admin' })],
    ['a changeme token', config({ 'changeme-admin-token-long': 'admin' })],
    ['an example token', config({ 'my-example-admin-token': 'admin' })],
  ])('accepts %s with a warning that names only the setting', (_label, raw) => {
    const result = parseTokenConfig(raw);
    expect(result).toMatchObject({ ok: true, warnings: [TokenConfigWarning.Weak] });
    expect(JSON.stringify(result.ok ? result.warnings : [])).not.toMatch(
      /replace-with-|tiny1|changeme|example/i,
    );
  });

  it('has no warnings for strong tokens', () => {
    expect(parseTokenConfig(cfg)).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('TokenTable', () => {
  it('stores SHA-256 digests and roles, never raw tokens', () => {
    const table = expectTable(cfg);
    const dump = [
      JSON.stringify(table),
      util.inspect(table, { depth: Infinity, showHidden: true }),
    ].join('\n');
    expect(dump).not.toContain(ADMIN);
    expect(dump).not.toContain(VIEWER);
    const sha = (token: string) => createHash('sha256').update(token).digest();
    expect(
      table.map((entry) => [
        entry.digest.equals(sha(ADMIN)) || entry.digest.equals(sha(VIEWER)),
        entry.digest.length,
      ]),
    ).toEqual([
      [true, 32],
      [true, 32],
    ]);
  });

  it('is frozen', () => {
    const table = expectTable(cfg);
    expect(Object.isFrozen(table)).toBe(true);
    for (const entry of table) expect(Object.isFrozen(entry)).toBe(true);
  });
});
