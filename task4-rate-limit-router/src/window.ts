export interface UsageRow {
  ts: number;
  tokens: number;
}

// A row counts while it is inside the window. A row exactly one window old has aged out, so the
// window is (now - windowMs, now].
export function windowStart(now: number, windowMs: number): number {
  return now - windowMs;
}

// Milliseconds until `cost` tokens fit. Rows leave the window in timestamp order, so the answer is
// the first row whose departure frees enough room. `rows` must be sorted by ts ascending.
export function retryAfterMs(
  rows: readonly UsageRow[],
  now: number,
  windowMs: number,
  limit: number,
  cost: number,
): number {
  const inWindow = rows.filter((row) => row.ts > windowStart(now, windowMs));
  let remaining = inWindow.reduce((sum, row) => sum + row.tokens, 0);
  if (remaining + cost <= limit) return 0;
  for (const row of inWindow) {
    remaining -= row.tokens;
    if (remaining + cost <= limit) return Math.max(0, row.ts + windowMs - now);
  }
  // Even an empty window cannot fit this cost; the client is told the full window.
  return windowMs;
}
