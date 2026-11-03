import { createLogger, parseLogLevel } from '../shared/logger.js';
import { systemClock } from './src/clock.js';
import { parseRouterConfig } from './src/config.js';
import { openDatabase } from './src/db.js';
import { createLimiter } from './src/limiter.js';
import { createHttpProvider } from './src/providers.js';
import { createRouterServer } from './src/server.js';

const logger = createLogger({
  service: 'task4-rate-limit-router',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

const result = parseRouterConfig(process.env);
if (!result.ok) {
  logger.error('invalid configuration', { fields: result.fields });
  process.exit(1);
}
const { config } = result;

const db = openDatabase(config.sqlitePath);
const server = createRouterServer({
  limiter: createLimiter({
    db,
    clock: systemClock,
    limit: config.limit,
    windowMs: config.windowMs,
    // Both providers may run to their timeouts before a reservation is settled.
    reservationTtlMs: config.primary.timeoutMs + config.secondary.timeoutMs + 5000,
  }),
  primary: createHttpProvider({ name: 'primary', logger, ...config.primary }),
  secondary: createHttpProvider({ name: 'secondary', logger, ...config.secondary }),
  logger,
});

try {
  const { port, url } = await server.listen(config.port);
  logger.info('listening', { port, url });
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
  logger.error('listen failed', { error_code: code });
  db.close();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void server.close().then(() => db.close());
  });
}
