import { z } from 'zod';
import { isValidTokenSyntax } from './bearer.js';
import { parseTokenConfig, type TokenTable } from './token-config.js';

export interface GatewayConfig {
  port: number;
  downstreamUrl: string;
  downstreamToken: string;
  timeoutMs: number;
  table: TokenTable;
}

export type GatewayConfigResult =
  | { ok: true; config: GatewayConfig; warnings: readonly string[] }
  | { ok: false; fields: string[] };

const DEFAULT_DOWNSTREAM_URL = 'http://127.0.0.1:8081/mcp';
// Node treats a setTimeout delay above 2^31 - 1 as 1 ms, which would time out every request.
const MAX_TIMER_MS = 2_147_483_647;

// An empty value (e.g. "GATEWAY_PORT=" in .env) means "unset", as in the mock's config.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

// Digits only: Number() would also accept "0x1F90", "1e3" and "-0".
const integerSetting = (min: number, max: number, fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(min).max(max))
      .default(fallback),
  );

// Stored normalized. Userinfo is refused because fetch() throws on credentials in a URL, and the
// downstream credential belongs in DOWNSTREAM_AUTH_TOKEN.
function normalizeDownstreamUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

const schema = z.object({
  GATEWAY_PORT: integerSetting(0, 65_535, 8080),
  DOWNSTREAM_MCP_URL: z.preprocess(
    blankToUndefined,
    z
      .string()
      .transform((value, ctx) => {
        const url = normalizeDownstreamUrl(value);
        if (url === undefined) {
          ctx.addIssue({ code: 'custom', message: 'invalid URL' });
          return z.NEVER;
        }
        return url;
      })
      .default(DEFAULT_DOWNSTREAM_URL),
  ),
  DOWNSTREAM_TIMEOUT_MS: integerSetting(1, MAX_TIMER_MS, 5000),
  DOWNSTREAM_AUTH_TOKEN: z.string().refine(isValidTokenSyntax),
});

export function parseGatewayConfig(env: Record<string, string | undefined>): GatewayConfigResult {
  const parsed = schema.safeParse(env);
  const tokens = parseTokenConfig(env.GATEWAY_TOKENS);

  // Names only: the values may be secrets.
  const fields = parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0]));
  if (!tokens.ok) fields.push('GATEWAY_TOKENS');
  if (!parsed.success || !tokens.ok) return { ok: false, fields: [...new Set(fields)] };

  return {
    ok: true,
    config: {
      port: parsed.data.GATEWAY_PORT,
      downstreamUrl: parsed.data.DOWNSTREAM_MCP_URL,
      downstreamToken: parsed.data.DOWNSTREAM_AUTH_TOKEN,
      timeoutMs: parsed.data.DOWNSTREAM_TIMEOUT_MS,
      table: tokens.table,
    },
    warnings: tokens.warnings,
  };
}

// Once parsed, the secrets live only in the config; removing them from the environment keeps
// them out of child processes and anything that dumps process.env.
export function consumeSecrets(env: Record<string, string | undefined>): void {
  delete env.GATEWAY_TOKENS;
  delete env.DOWNSTREAM_AUTH_TOKEN;
}
