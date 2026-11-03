import { describe, expect, it } from 'vitest';
import { hasBearerToken, parseBearerToken, tokensMatch } from '../src/bearer.js';

const cyrillicDze = String.fromCodePoint(0x455);

describe('parseBearerToken', () => {
  it.each([
    ['Bearer s3cret', 's3cret'],
    ['bearer s3cret', 's3cret'],
    ['BEARER s3cret', 's3cret'],
  ])('reads the token from %j (scheme is case-insensitive, RFC 7235)', (header, token) => {
    expect(parseBearerToken(header)).toBe(token);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'Basic czNjcmV0',
    'Token s3cret',
    'Bearer  s3cret',
    'Bearer s3cret ',
    ' Bearer s3cret',
    'Bearer s3cret,Bearer s3cret',
    'Bearer a b',
    'Bearer\ts3cret',
  ])('rejects malformed header %j', (header) => {
    expect(parseBearerToken(header)).toBeUndefined();
  });
});

describe('tokensMatch', () => {
  it('accepts the exact token', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true);
  });

  it.each([
    's3cre',
    's3cretX',
    'S3CRET',
    `${cyrillicDze}3cret`,
    'client-viewer-token',
    'a'.repeat(10_000),
  ])('rejects %j without throwing on length differences', (presented) => {
    expect(tokensMatch(presented, 's3cret')).toBe(false);
  });
});

describe('hasBearerToken', () => {
  it('combines parsing and constant-time comparison', () => {
    expect(hasBearerToken('Bearer s3cret', 's3cret')).toBe(true);
    expect(hasBearerToken('bearer s3cret', 's3cret')).toBe(true);
    expect(hasBearerToken('Bearer s3cret ', 's3cret')).toBe(false);
    expect(hasBearerToken(undefined, 's3cret')).toBe(false);
  });
});
