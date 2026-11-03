import { describe, expect, it } from 'vitest';
import { consumeSecrets, parseGatewayConfig } from '../src/gateway-config.js';
import { TokenConfigWarning } from '../src/token-config.js';

const STRONG = 'strong-token-xyz-1';
const base = {
  GATEWAY_TOKENS: JSON.stringify({ [STRONG]: 'admin' }),
  DOWNSTREAM_AUTH_TOKEN: 'dt-token',
};

function parse(overrides: Record<string, string | undefined> = {}) {
  return parseGatewayConfig({ ...base, ...overrides });
}

function config(overrides: Record<string, string | undefined> = {}) {
  const result = parse(overrides);
  if (!result.ok) throw new Error(`expected ok, got ${result.fields.join(',')}`);
  return result.config;
}

describe('parseGatewayConfig', () => {
  it('applies defaults', () => {
    const result = parse();
    expect(result).toMatchObject({
      ok: true,
      config: {
        port: 8080,
        downstreamUrl: 'http://127.0.0.1:8081/mcp',
        timeoutMs: 5000,
        downstreamToken: 'dt-token',
      },
      warnings: [],
    });
    expect(config().table).toHaveLength(1);
  });

  it.each([
    ['GATEWAY_PORT', 'port', 8080],
    ['DOWNSTREAM_MCP_URL', 'downstreamUrl', 'http://127.0.0.1:8081/mcp'],
    ['DOWNSTREAM_TIMEOUT_MS', 'timeoutMs', 5000],
  ] as const)('treats a blank %s as unset', (name, key, fallback) => {
    for (const blank of ['', '   ']) expect(config({ [name]: blank })[key]).toBe(fallback);
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['65535', 65_535],
    [' 8080 ', 8080],
  ])('accepts port %j', (value, expected) => {
    expect(config({ GATEWAY_PORT: value }).port).toBe(expected);
  });

  it.each(['-1', '65536', '1.5', 'abc', 'Infinity', 'NaN', '0x1F90', '1e3', '-0', '+1'])(
    'rejects port %j (digits only)',
    (value) => {
      expect(parse({ GATEWAY_PORT: value })).toEqual({ ok: false, fields: ['GATEWAY_PORT'] });
    },
  );

  it.each([
    ['http://127.0.0.1:9/mcp', 'http://127.0.0.1:9/mcp'],
    ['https://host.example/mcp', 'https://host.example/mcp'],
    ['HTTP://H/mcp', 'http://h/mcp'],
    [' http://127.0.0.1:9/mcp ', 'http://127.0.0.1:9/mcp'],
  ])('accepts and normalizes the URL %j', (value, expected) => {
    expect(config({ DOWNSTREAM_MCP_URL: value }).downstreamUrl).toBe(expected);
  });

  it.each([
    'ftp://h/mcp',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '/mcp',
    'http://user:pass@h/mcp',
    'http://user@h/mcp',
  ])('rejects the URL %j', (value) => {
    expect(parse({ DOWNSTREAM_MCP_URL: value })).toEqual({
      ok: false,
      fields: ['DOWNSTREAM_MCP_URL'],
    });
  });

  it.each([
    ['1', 1],
    ['2147483647', 2_147_483_647],
  ])('accepts timeout %j', (value, expected) => {
    expect(config({ DOWNSTREAM_TIMEOUT_MS: value }).timeoutMs).toBe(expected);
  });

  it.each(['0', '-1', '1.5', 'abc', '1e309', '2147483648', '1e3'])(
    'rejects timeout %j',
    (value) => {
      expect(parse({ DOWNSTREAM_TIMEOUT_MS: value })).toEqual({
        ok: false,
        fields: ['DOWNSTREAM_TIMEOUT_MS'],
      });
    },
  );

  it.each([undefined, '', 'a b', 'tok==a', `t${String.fromCodePoint(0xf8)}k`])(
    'rejects downstream token %j',
    (value) => {
      expect(parse({ DOWNSTREAM_AUTH_TOKEN: value })).toEqual({
        ok: false,
        fields: ['DOWNSTREAM_AUTH_TOKEN'],
      });
    },
  );

  it.each(['tok=', 'a.b~c+/-'])('accepts downstream token %j', (value) => {
    expect(config({ DOWNSTREAM_AUTH_TOKEN: value }).downstreamToken).toBe(value);
  });

  it.each([
    undefined,
    '',
    '[]',
    '{}',
    JSON.stringify({ [STRONG]: 'root' }),
    '{"a b":"admin"}',
    `{"${STRONG}":"admin","${STRONG}":"viewer"}`,
  ])('rejects GATEWAY_TOKENS %j without echoing it', (value) => {
    const result = parse({ GATEWAY_TOKENS: value });
    expect(result).toEqual({ ok: false, fields: ['GATEWAY_TOKENS'] });
    expect(JSON.stringify(result)).not.toContain(STRONG);
  });

  it('reports every bad setting by name only, once each', () => {
    const result = parseGatewayConfig({
      GATEWAY_PORT: 'secret-port',
      DOWNSTREAM_MCP_URL: 'ftp://secret-host/x',
      DOWNSTREAM_TIMEOUT_MS: '0',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.fields].sort()).toEqual([
      'DOWNSTREAM_AUTH_TOKEN',
      'DOWNSTREAM_MCP_URL',
      'DOWNSTREAM_TIMEOUT_MS',
      'GATEWAY_PORT',
      'GATEWAY_TOKENS',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret/);
  });

  it('warns about the .env.example placeholder tokens and not about strong ones', () => {
    const placeholder = parse({
      GATEWAY_TOKENS: '{"replace-with-admin-token":"admin","replace-with-viewer-token":"viewer"}',
    });
    expect(placeholder).toMatchObject({ ok: true, warnings: [TokenConfigWarning.Weak] });
    expect(parse()).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('consumeSecrets', () => {
  it('removes the secret settings and leaves the rest, idempotently', () => {
    const env: Record<string, string | undefined> = {
      GATEWAY_TOKENS: 'x',
      DOWNSTREAM_AUTH_TOKEN: 'z',
      OTHER: 'y',
    };
    consumeSecrets(env);
    expect(Object.hasOwn(env, 'GATEWAY_TOKENS')).toBe(false);
    expect(env.OTHER).toBe('y');
    consumeSecrets(env);
    expect(env).toEqual({ OTHER: 'y' });
  });
});
