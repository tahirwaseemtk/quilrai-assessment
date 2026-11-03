import { timingSafeEqual } from 'node:crypto';
import { parseBearerToken, tokenDigest } from './bearer.js';
import type { Role, TokenTable } from './token-config.js';

export type AuthFailure = 'missing' | 'malformed' | 'duplicate' | 'unknown';
export type AuthResult = { ok: true; role: Role } | { ok: false; reason: AuthFailure };
export type DigestComparator = (a: Buffer, b: Buffer) => boolean;

export const constantTimeEqual: DigestComparator = timingSafeEqual;

// Takes Node's `req.headersDistinct.authorization` (every value, in order), never the
// de-duplicated `req.headers.authorization`: the type keeps the duplicate check from being
// bypassed. More than one header is refused outright, because a proxy keeping the last value and
// Node keeping the first would otherwise disagree about which token was presented.
export function authenticate(
  authorization: readonly string[] | undefined,
  table: TokenTable,
  compare: DigestComparator = constantTimeEqual,
): AuthResult {
  const values = authorization ?? [];
  if (values.length > 1) return { ok: false, reason: 'duplicate' };
  const header = values[0];
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };

  const token = parseBearerToken(header);
  if (token === undefined) return { ok: false, reason: 'malformed' };

  // Every entry is compared, with no early exit, so the response time does not reveal whether
  // or where the token appears in the table.
  const presented = tokenDigest(token);
  let role: Role | undefined;
  for (const entry of table) {
    if (compare(presented, entry.digest)) role ??= entry.role;
  }
  return role ? { ok: true, role } : { ok: false, reason: 'unknown' };
}
