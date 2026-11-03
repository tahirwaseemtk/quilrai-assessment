import type Database from 'better-sqlite3';
import type { Clock } from './clock.js';
import { retryAfterMs, type UsageRow } from './window.js';

export interface Reservation {
  id: number;
}

export interface LimiterOptions {
  db: Database.Database;
  clock: Clock;
  limit: number;
  windowMs: number;
  // How long a reservation may stay open. Must exceed the worst-case provider time, or a call still
  // in flight would stop counting.
  reservationTtlMs: number;
}

export interface Limiter {
  // The most tokens one request can be admitted with, which is the whole limit.
  readonly capacity: number;
  // Admits `cost` tokens for the tenant or throws RateLimitedError. Eviction and the check run in
  // one immediate transaction, so two connections cannot both see the last tokens as free.
  reserve(tenant: string, cost: number): Reservation;
  // Replaces the estimate with the usage the provider reported.
  reconcile(reservation: Reservation, tokens: number): void;
  // Gives back a reservation whose request failed on every provider.
  release(reservation: Reservation): void;
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('rate limited');
  }
}

export function createLimiter({
  db,
  clock,
  limit,
  windowMs,
  reservationTtlMs,
}: LimiterOptions): Limiter {
  // Eviction is global, not per tenant, so rows of keys that never return are removed too.
  // Settled usage ages out with the window. An open reservation counts until its own TTL, so a
  // slow provider cannot have its tokens evicted while the call is still running.
  const evictAll = db.prepare(
    "DELETE FROM usage WHERE (status = 'settled' AND ts <= ?) OR (status = 'reserved' AND ts <= ?)",
  );
  const sumInWindow = db.prepare(
    "SELECT COALESCE(SUM(tokens), 0) AS used FROM usage WHERE tenant_hash = ? AND ((status = 'settled' AND ts > ?) OR (status = 'reserved' AND ts > ?))",
  );
  const rowsInWindow = db.prepare(
    "SELECT ts, tokens FROM usage WHERE tenant_hash = ? AND ((status = 'settled' AND ts > ?) OR (status = 'reserved' AND ts > ?)) ORDER BY ts, id",
  );
  const insert = db.prepare(
    "INSERT INTO usage (tenant_hash, ts, tokens, status) VALUES (?, ?, ?, 'reserved') RETURNING id",
  );
  const settle = db.prepare("UPDATE usage SET tokens = ?, status = 'settled' WHERE id = ?");
  const remove = db.prepare('DELETE FROM usage WHERE id = ?');

  const reserveTx = db.transaction((tenant: string, cost: number): Reservation => {
    const now = clock.now();
    evictAll.run(now - windowMs, now - reservationTtlMs);
    const { used } = sumInWindow.get(tenant, now - windowMs, now - reservationTtlMs) as {
      used: number;
    };
    if (used + cost > limit) {
      // Rows are read only on refusal, to work out when the request would fit.
      const rows = rowsInWindow.all(tenant, now - windowMs, now - reservationTtlMs) as UsageRow[];
      const wait = retryAfterMs(rows, now, windowMs, limit, cost);
      throw new RateLimitedError(Math.max(1, Math.ceil(wait / 1000)));
    }
    const { id } = insert.get(tenant, now, cost) as { id: number };
    return { id };
  });

  return {
    capacity: limit,
    reserve: (tenant, cost) => reserveTx.immediate(tenant, cost),
    reconcile: (reservation, tokens) => {
      settle.run(tokens, reservation.id);
    },
    release: (reservation) => {
      remove.run(reservation.id);
    },
  };
}
