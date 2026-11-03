import { z } from 'zod';

export interface ProviderSettings {
  url: string;
  apiKey: string;
  timeoutMs: number;
}

export interface RouterConfig {
  port: number;
  sqlitePath: string;
  limit: number;
  windowMs: number;
  primary: ProviderSettings;
  secondary: ProviderSettings;
}

export type RouterConfigResult =
  { ok: true; config: RouterConfig } | { ok: false; fields: string[] };

// An empty value (e.g. "ROUTER_PORT=" in .env) means unset, as in the other tasks.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const integer = (min: number, max: number, fallback: number) =>
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

// Checked here so a bad value fails at startup, not on the first request.
const providerUrl = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value.trim());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // Reported below with the other fields.
  }
  ctx.addIssue({ code: 'custom', message: 'invalid provider URL' });
  return z.NEVER;
});

const schema = z.object({
  ROUTER_PORT: integer(0, 65_535, 8100),
  SQLITE_PATH: z.preprocess(blankToUndefined, z.string().min(1).default('data/rate-limit.db')),
  RATE_LIMIT_TOKENS: integer(1, 1_000_000_000, 50_000),
  RATE_LIMIT_WINDOW_MS: integer(1000, 86_400_000, 60_000),
  PRIMARY_MODEL_URL: providerUrl,
  PRIMARY_API_KEY: z.string().trim().min(1),
  PRIMARY_TIMEOUT_MS: integer(1, 2_147_483_647, 3000),
  SECONDARY_MODEL_URL: providerUrl,
  SECONDARY_API_KEY: z.string().trim().min(1),
  SECONDARY_TIMEOUT_MS: integer(1, 2_147_483_647, 3000),
});

// Names only in the result: the values may be secrets.
export function parseRouterConfig(env: Record<string, string | undefined>): RouterConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))],
    };
  }
  const data = parsed.data;
  return {
    ok: true,
    config: {
      port: data.ROUTER_PORT,
      sqlitePath: data.SQLITE_PATH,
      limit: data.RATE_LIMIT_TOKENS,
      windowMs: data.RATE_LIMIT_WINDOW_MS,
      primary: {
        url: data.PRIMARY_MODEL_URL,
        apiKey: data.PRIMARY_API_KEY,
        timeoutMs: data.PRIMARY_TIMEOUT_MS,
      },
      secondary: {
        url: data.SECONDARY_MODEL_URL,
        apiKey: data.SECONDARY_API_KEY,
        timeoutMs: data.SECONDARY_TIMEOUT_MS,
      },
    },
  };
}
