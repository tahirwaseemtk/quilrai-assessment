import { createLogger, parseLogLevel } from '../../shared/logger.js';
import { parseMockConfig } from './config.js';
import { createMockDownstream } from './server.js';

const logger = createLogger({
  service: 'mock-downstream',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

const result = parseMockConfig(process.env);
if (!result.ok) {
  logger.error('invalid configuration', { fields: result.fields });
  process.exit(1);
}

const mock = createMockDownstream({ authToken: result.config.authToken, logger });
const { port, url } = await mock.listen(result.config.port);
logger.info('listening', { port, url });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void mock.close();
  });
}
