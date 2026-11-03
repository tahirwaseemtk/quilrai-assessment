import type { Logger } from '../../shared/logger.js';

export type ProviderOutcome =
  // Served. `totalTokens` is the provider's reported usage, when it sent one.
  | { kind: 'ok'; body: string; totalTokens?: number }
  // Worth trying elsewhere: 429, 5xx, timeout, or a network failure.
  | { kind: 'retryable'; reason: string }
  // The request itself is at fault; another provider would refuse it too.
  | { kind: 'rejected'; status: number };

export interface ProviderClient {
  complete(body: string): Promise<ProviderOutcome>;
}

export interface HttpProviderOptions {
  name: string;
  url: string;
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
}

// The timeout covers the whole call, body included, so a provider that trickles its answer
// cannot hold the request beyond the deadline. A late answer is ignored once the call settles.
export function createHttpProvider(options: HttpProviderOptions): ProviderClient {
  return {
    async complete(body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
          signal: controller.signal,
          // A redirect would resend the provider key to wherever it points.
          redirect: 'error',
        });
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: 'retryable', reason: `status ${response.status}` };
        }
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: 'rejected', status: response.status };
        }
        const text = await readBounded(response, MAX_PROVIDER_BYTES);
        if (text === undefined) return { kind: 'retryable', reason: 'body too large' };
        const totalTokens = usageTotal(text);
        if (totalTokens === null) return { kind: 'retryable', reason: 'malformed body' };
        return totalTokens === undefined
          ? { kind: 'ok', body: text }
          : { kind: 'ok', body: text, totalTokens };
      } catch (error) {
        const aborted = controller.signal.aborted;
        const code = errorCode(error);
        options.logger.warn('provider call failed', {
          provider: options.name,
          reason: aborted ? 'timeout' : code,
        });
        return { kind: 'retryable', reason: aborted ? 'timeout' : 'network' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// A provider reply larger than this is treated as a failure. The timeout bounds time; this bounds
// memory, so a provider streaming a huge body cannot exhaust the router.
export const MAX_PROVIDER_BYTES = 1_048_576;

// Reads the body up to `limit` bytes, or returns undefined and cancels the rest.
async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// The usage total from a provider body: a number, undefined when absent, null when the body is
// not JSON. Only the count is read; nothing else from the body is ever logged or returned in errors.
function usageTotal(text: string): number | undefined | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const usage = (json as { usage?: { total_tokens?: unknown } } | null)?.usage;
  const total = usage?.total_tokens;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined;
}

// A short code only (ECONNREFUSED, UND_ERR_SOCKET, ...); messages can carry the provider URL.
function errorCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return 'UNKNOWN';
}
