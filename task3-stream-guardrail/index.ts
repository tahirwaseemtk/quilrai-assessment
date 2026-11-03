import { createLogger, parseLogLevel } from '../shared/logger.js';
import { parseGuardrailConfig } from './src/config.js';
import { createGuardrail } from './src/guardrail.js';

const logger = createLogger({
  service: 'task3-stream-guardrail',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

const result = parseGuardrailConfig(process.env);
if (!result.ok) {
  logger.error('invalid configuration', { fields: result.fields });
  process.exit(1);
}

const { config } = result;
const guardrail = createGuardrail({
  providerUrl: config.providerUrl,
  providerApiKey: config.providerApiKey,
  logger,
});
try {
  const { port, url } = await guardrail.listen(config.port);
  logger.info('listening', { port, url });
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
  logger.error('listen failed', { error_code: code });
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void guardrail.close();
  });
}
