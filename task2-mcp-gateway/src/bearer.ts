import { createHash, timingSafeEqual } from 'node:crypto';

// RFC 6750 token68 characters only, so zero-width, non-ASCII or separator characters can never
// form part of a token. The scheme is case-insensitive (RFC 7235); the token is not. Node's HTTP
// parser already trims surrounding whitespace from header values; inside the value exactly one
// space must separate scheme and token.
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*$/;
const BEARER = /^bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export function isValidTokenSyntax(token: string): boolean {
  return TOKEN68.test(token);
}

export function parseBearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : BEARER.exec(header)?.[1];
}

export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

// Hashing first gives equal-length inputs, so timingSafeEqual never throws on a length
// mismatch and the comparison time does not depend on how much of the token matched.
export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(tokenDigest(presented), tokenDigest(expected));
}

export function hasBearerToken(header: string | undefined, expected: string): boolean {
  const token = parseBearerToken(header);
  return token !== undefined && tokensMatch(token, expected);
}
