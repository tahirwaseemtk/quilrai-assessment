import { z } from 'zod';

export interface GuardrailConfig {
  port: number;
  providerUrl: string;
  providerApiKey: string;
}

export type GuardrailConfigResult =
  { ok: true; config: GuardrailConfig } | { ok: false; fields: string[] };

const DEFAULT_PROVIDER_URL = 'http://127.0.0.1:8091/v1/chat/completions';

// An empty value (e.g. "GUARDRAIL_PORT=" in .env) means unset, as in the other tasks.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const schema = z.object({
  GUARDRAIL_PORT: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(65_535))
      .default(8090),
  ),
  LLM_PROVIDER_URL: z.preprocess(
    blankToUndefined,
    z
      .string()
      .transform((value, ctx) => {
        try {
          const url = new URL(value.trim());
          if (
            (url.protocol !== 'http:' && url.protocol !== 'https:') ||
            url.username ||
            url.password
          ) {
            ctx.addIssue({ code: 'custom', message: 'invalid provider URL' });
            return z.NEVER;
          }
          return url.href;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'invalid provider URL' });
          return z.NEVER;
        }
      })
      .default(DEFAULT_PROVIDER_URL),
  ),
  LLM_PROVIDER_API_KEY: z.string().trim().min(1),
});

// Names only in the result: the values may be secrets.
export function parseGuardrailConfig(
  env: Record<string, string | undefined>,
): GuardrailConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))],
    };
  }
  return {
    ok: true,
    config: {
      port: parsed.data.GUARDRAIL_PORT,
      providerUrl: parsed.data.LLM_PROVIDER_URL,
      providerApiKey: parsed.data.LLM_PROVIDER_API_KEY,
    },
  };
}
