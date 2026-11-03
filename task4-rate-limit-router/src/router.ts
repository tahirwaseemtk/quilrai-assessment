import type { Logger } from '../../shared/logger.js';
import { ErrorCode, type ErrorCodeValue } from './errors.js';
import { type Limiter, type Reservation, RateLimitedError } from './limiter.js';
import type { ProviderClient, ProviderOutcome } from './providers.js';
import { type CompletionRequest, estimateTokens } from './request.js';

export interface RouterDeps {
  limiter: Limiter;
  primary: ProviderClient;
  secondary: ProviderClient;
  logger: Logger;
}

export type RouteResult =
  { ok: true; body: string } | { ok: false; code: ErrorCodeValue; retryAfterSeconds?: number };

type Served = Extract<ProviderOutcome, { kind: 'ok' }>;

interface Attempt {
  reservation: Reservation;
  cost: number;
  requestId: string;
  settled: boolean;
}

// Admits the request against the tenant's window, then tries the primary and fails over to the
// secondary only when the primary is retryable. A reservation is settled with the reported usage
// when a provider serves the request, and released on every other path, including an unexpected
// error, so a crash cannot hold tokens for a whole window.
export async function route(
  input: { tenant: string; request: CompletionRequest; body: string; requestId: string },
  deps: RouterDeps,
): Promise<RouteResult> {
  const { limiter, logger } = deps;
  const cost = estimateTokens(input.request);
  // A request larger than the whole limit can never be admitted, so waiting would not help.
  if (cost > limiter.capacity) return { ok: false, code: ErrorCode.InvalidRequest };

  let reservation: Reservation;
  try {
    reservation = limiter.reserve(input.tenant, cost);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return { ok: false, code: ErrorCode.RateLimited, retryAfterSeconds: error.retryAfterSeconds };
    }
    throw error;
  }

  const attempt: Attempt = { reservation, cost, requestId: input.requestId, settled: false };
  try {
    return await chain(input.body, attempt, deps);
  } catch (error) {
    if (!attempt.settled) limiter.release(reservation);
    logger.error('router failed during provider calls', { request_id: input.requestId });
    throw error;
  }
}

async function chain(body: string, attempt: Attempt, deps: RouterDeps): Promise<RouteResult> {
  const { limiter, logger } = deps;
  const { reservation, requestId } = attempt;

  const primary = await deps.primary.complete(body);
  if (primary.kind === 'ok') return served(primary, attempt, deps);
  if (primary.kind === 'rejected') {
    // Another provider would refuse the same request, so there is no failover.
    limiter.release(reservation);
    logger.error('provider rejected request', { request_id: requestId, status: primary.status });
    return { ok: false, code: ErrorCode.UpstreamRejected };
  }
  logger.warn('primary failed, trying secondary', {
    request_id: requestId,
    reason: primary.reason,
  });

  const secondary = await deps.secondary.complete(body);
  if (secondary.kind === 'ok') return served(secondary, attempt, deps);
  limiter.release(reservation);
  if (secondary.kind === 'rejected') {
    logger.error('secondary rejected request', { request_id: requestId, status: secondary.status });
    return { ok: false, code: ErrorCode.UpstreamRejected };
  }
  logger.error('all providers failed', { request_id: requestId, reason: secondary.reason });
  return { ok: false, code: ErrorCode.UpstreamUnavailable };
}

function served(outcome: Served, attempt: Attempt, deps: RouterDeps): RouteResult {
  const tokens = outcome.totalTokens ?? attempt.cost;
  deps.limiter.reconcile(attempt.reservation, tokens);
  attempt.settled = true;
  deps.logger.info('request served', { request_id: attempt.requestId, tokens });
  return { ok: true, body: outcome.body };
}
