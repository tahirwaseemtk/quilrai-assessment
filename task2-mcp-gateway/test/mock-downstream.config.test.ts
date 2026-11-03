import { describe, expect, it } from 'vitest';
import { parseMockConfig } from '../mock-downstream/config.js';

describe('parseMockConfig', () => {
  it('reads the port and token', () => {
    expect(parseMockConfig({ MOCK_DOWNSTREAM_PORT: '9000', DOWNSTREAM_AUTH_TOKEN: 'tok' })).toEqual(
      { ok: true, config: { port: 9000, authToken: 'tok' } },
    );
  });

  it.each([undefined, '', '   '])('defaults the port to 8081 when it is %j', (port) => {
    expect(parseMockConfig({ MOCK_DOWNSTREAM_PORT: port, DOWNSTREAM_AUTH_TOKEN: 'tok' })).toEqual({
      ok: true,
      config: { port: 8081, authToken: 'tok' },
    });
  });

  it('accepts port 0 for an ephemeral port', () => {
    expect(parseMockConfig({ MOCK_DOWNSTREAM_PORT: '0', DOWNSTREAM_AUTH_TOKEN: 'tok' })).toEqual({
      ok: true,
      config: { port: 0, authToken: 'tok' },
    });
  });

  it.each(['-1', '65536', '80.5', 'abc'])('rejects port %j by name only', (port) => {
    expect(parseMockConfig({ MOCK_DOWNSTREAM_PORT: port, DOWNSTREAM_AUTH_TOKEN: 'tok' })).toEqual({
      ok: false,
      fields: ['MOCK_DOWNSTREAM_PORT'],
    });
  });

  it.each([undefined, '', '   '])('rejects a token of %j by name only', (token) => {
    expect(parseMockConfig({ DOWNSTREAM_AUTH_TOKEN: token })).toEqual({
      ok: false,
      fields: ['DOWNSTREAM_AUTH_TOKEN'],
    });
  });
});
