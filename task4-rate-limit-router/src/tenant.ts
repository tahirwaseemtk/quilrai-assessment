import { createHash } from 'node:crypto';

// Tenant keys are stored only as SHA-256 digests, so the database never holds a raw key.
export function tenantHash(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

// RFC 6750 token68: the characters an API key may use, with optional trailing "=".
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export function parseTenantKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return BEARER.exec(header)?.[1];
}
