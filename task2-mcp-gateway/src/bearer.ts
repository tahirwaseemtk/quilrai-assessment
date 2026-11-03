import { createHash, timingSafeEqual } from 'node:crypto';

// Exactly "<scheme> <token>": one space and no surrounding whitespace, so padded or doubled
// variants never authenticate. The scheme is case-insensitive (RFC 7235); the token is not.
const BEARER = /^bearer ([^\s,]+)$/i;

export function parseBearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : BEARER.exec(header)?.[1];
}

// Hashing first gives equal-length inputs, so timingSafeEqual never throws on a length
// mismatch and the comparison time does not depend on how much of the token matched.
export function tokensMatch(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export function hasBearerToken(header: string | undefined, expected: string): boolean {
  const token = parseBearerToken(header);
  return token !== undefined && tokensMatch(token, expected);
}
