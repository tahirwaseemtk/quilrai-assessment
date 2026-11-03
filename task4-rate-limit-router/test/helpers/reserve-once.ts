// Child process used by the concurrency test: opens its own connection to the shared database,
// waits for a start signal file, then reserves as many fixed-cost requests as it can.
import { existsSync } from 'node:fs';
import { openDatabase } from '../../src/db.js';
import { createLimiter, RateLimitedError } from '../../src/limiter.js';
import { tenantHash } from '../../src/tenant.js';

const [databasePath, startFile, limitText, costText, attemptsText] = process.argv.slice(2);
if (!databasePath || !startFile || !limitText || !costText || !attemptsText) {
  throw new Error('usage: reserve-once <db> <startFile> <limit> <cost> <attempts>');
}

const db = openDatabase(databasePath);
const limiter = createLimiter({
  db,
  clock: { now: () => Date.now() },
  limit: Number(limitText),
  windowMs: 60_000,
  reservationTtlMs: 60_000,
});
const tenant = tenantHash('shared-tenant-key');

while (!existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 1));

let granted = 0;
for (let attempt = 0; attempt < Number(attemptsText); attempt++) {
  try {
    limiter.reserve(tenant, Number(costText));
    granted++;
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
  }
}
db.close();
process.stdout.write(`${granted}\n`);
