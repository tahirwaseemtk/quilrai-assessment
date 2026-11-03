import { z } from 'zod';
import { isValidTokenSyntax, tokenDigest } from './bearer.js';

export type Role = 'admin' | 'viewer';

// Only the SHA-256 digest is kept: the raw tokens never live past parsing.
export interface TokenEntry {
  readonly digest: Buffer;
  readonly role: Role;
}

export type TokenTable = readonly TokenEntry[];

// Fixed strings: a reason must never echo a configured token.
export const TokenConfigError = {
  Required: 'GATEWAY_TOKENS is required',
  NotObject: 'GATEWAY_TOKENS must be a JSON object',
  Empty: 'GATEWAY_TOKENS must contain at least one token',
  InvalidRole: 'GATEWAY_TOKENS has an invalid role',
  InvalidToken: 'GATEWAY_TOKENS has an invalid token',
  Duplicate: 'GATEWAY_TOKENS has a duplicated token',
} as const;

export const TokenConfigWarning = {
  Weak: 'GATEWAY_TOKENS contains a placeholder or short token',
} as const;

export type TokenConfigResult =
  | { readonly ok: true; readonly table: TokenTable; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const PLACEHOLDER_MARKERS = [
  'replace-with',
  'replace-me',
  'changeme',
  'change-me',
  'example',
  'placeholder',
];
const MIN_STRONG_LENGTH = 16;

const objectSchema = z.record(z.string(), z.unknown());
const roleSchema = z.enum(['admin', 'viewer']);

function isWeak(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    token.length < MIN_STRONG_LENGTH || PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))
  );
}

export function parseTokenConfig(raw: string | undefined): TokenConfigResult {
  if (raw === undefined || raw.trim() === '')
    return { ok: false, reason: TokenConfigError.Required };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: TokenConfigError.NotObject };
  }
  if (Array.isArray(parsed) || !objectSchema.safeParse(parsed).success) {
    return { ok: false, reason: TokenConfigError.NotObject };
  }

  // Entries are read from the parsed object itself, not from Zod's copy: the copy would drop an
  // own "__proto__" key. Object.entries reads own keys only, so prototype names are plain tokens.
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, reason: TokenConfigError.Empty };

  const table: TokenEntry[] = [];
  let weak = false;
  for (const [token, role] of entries) {
    if (!isValidTokenSyntax(token)) return { ok: false, reason: TokenConfigError.InvalidToken };
    const parsedRole = roleSchema.safeParse(role);
    if (!parsedRole.success) return { ok: false, reason: TokenConfigError.InvalidRole };
    weak ||= isWeak(token);
    table.push(Object.freeze({ digest: tokenDigest(token), role: parsedRole.data }));
  }

  // JSON.parse keeps the last of duplicated keys, which would silently change a token's role.
  // After validation every key is token68 and every value a bare role, so neither can contain a
  // quote and counting `"...":` in the raw text counts the keys exactly.
  const keysInSource = raw.match(/"(?:[^"\\]|\\.)*"\s*:/g)?.length ?? 0;
  if (keysInSource !== entries.length) return { ok: false, reason: TokenConfigError.Duplicate };

  return {
    ok: true,
    table: Object.freeze(table),
    warnings: Object.freeze(weak ? [TokenConfigWarning.Weak] : []),
  };
}
