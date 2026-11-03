import { createLogger, parseLogLevel } from '../shared/logger.js';
import { consumeSecrets, parseGatewayConfig } from './src/gateway-config.js';
import { createGateway } from './src/gateway.js';

const logger = createLogger({
  service: 'task2-mcp-gateway',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

const result = parseGatewayConfig(process.env);
consumeSecrets(process.env);
if (!result.ok) {
  logger.error('invalid configuration', { fields: result.fields });
  process.exit(1);
}
for (const warning of result.warnings) logger.warn(warning);

const { config } = result;
const gateway = createGateway({
  table: config.table,
  downstreamUrl: config.downstreamUrl,
  downstreamToken: config.downstreamToken,
  timeoutMs: config.timeoutMs,
  logger,
});
try {
  const { port, url } = await gateway.listen(config.port);
  logger.info('listening', { port, url });
} catch (error) {
  // A code (EADDRINUSE, EACCES) only, not Node's stack trace.
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
  logger.error('listen failed', { error_code: code });
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void gateway.close();
  });
}
