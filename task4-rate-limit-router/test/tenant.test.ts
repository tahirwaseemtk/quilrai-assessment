import { describe, expect, it } from 'vitest';
import { parseTenantKey, tenantHash } from '../src/tenant.js';

describe('tenantHash', () => {
  it('is a stable SHA-256 hex digest that does not contain the key', () => {
    const hash = tenantHash('tenant-key-0123456789');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(tenantHash('tenant-key-0123456789'));
    expect(hash).not.toContain('tenant-key');
  });
});

describe('parseTenantKey', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['Bearer a.b-c_d~e+f/g==', 'a.b-c_d~e+f/g=='],
  ])('accepts %s', (header, key) => {
    expect(parseTenantKey(header)).toBe(key);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'Basic abc',
    'Bearer a b',
    'Bearer a\u0000b',
    'Bearer  a',
  ])('refuses %j', (header) => {
    expect(parseTenantKey(header)).toBeUndefined();
  });
});
