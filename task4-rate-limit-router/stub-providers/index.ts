import { createLogger, parseLogLevel } from '../../shared/logger.js';
import { createStubProvider, type StubBehavior } from './server.js';

const logger = createLogger({
  service: 'stub-providers',
  level: parseLogLevel(process.env.LOG_LEVEL),
});

// Each stub's behavior can be set in the environment: ok, 429, 500, 400, hang or reset.
function behaviorFrom(value: string | undefined): StubBehavior {
  switch (value) {
    case '429':
    case '500':
    case '400':
      return { kind: 'status', status: Number(value) };
    case 'hang':
      return { kind: 'hang' };
    case 'reset':
      return { kind: 'reset' };
    default:
      return { kind: 'ok' };
  }
}

const primary = createStubProvider(behaviorFrom(process.env.STUB_PRIMARY_MODE));
const secondary = createStubProvider(behaviorFrom(process.env.STUB_SECONDARY_MODE));
const primaryAt = await primary.listen(Number(process.env.STUB_PRIMARY_PORT ?? 8101));
const secondaryAt = await secondary.listen(Number(process.env.STUB_SECONDARY_PORT ?? 8102));
logger.info('listening', { primary: primaryAt.url, secondary: secondaryAt.url });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([primary.close(), secondary.close()]);
  });
}
