import { z } from 'zod';
import { isValidTokenSyntax } from '../src/bearer.js';

export interface MockConfig {
  port: number;
  authToken: string;
}

export type MockConfigResult = { ok: true; config: MockConfig } | { ok: false; fields: string[] };

// An empty value (e.g. "MOCK_DOWNSTREAM_PORT=" in .env) means "unset": Number('') would be 0,
// which silently binds a random port instead of the default.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const schema = z.object({
  MOCK_DOWNSTREAM_PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).max(65_535).default(8081),
  ),
  DOWNSTREAM_AUTH_TOKEN: z.string().refine(isValidTokenSyntax),
});

export function parseMockConfig(env: Record<string, string | undefined>): MockConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only: the values may be secrets.
    return {
      ok: false,
      fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))],
    };
  }
  return {
    ok: true,
    config: {
      port: parsed.data.MOCK_DOWNSTREAM_PORT,
      authToken: parsed.data.DOWNSTREAM_AUTH_TOKEN,
    },
  };
}
