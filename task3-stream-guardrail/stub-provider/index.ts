import { createLogger, parseLogLevel } from '../../shared/logger.js';
import { createStubProvider } from './server.js';

const logger = createLogger({
  service: 'stub-provider',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

const port = Number(process.env.PROVIDER_STUB_PORT ?? 8091);
const provider = createStubProvider();
const { url } = await provider.listen(port);
logger.info('listening', { url });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void provider.close();
  });
}
