import { createMockCustomerRepository } from './src/customer-repository.js';
import { createLogger, parseLogLevel } from '../shared/logger.js';
import { createServer } from './src/server.js';
import { createTools } from './src/tools.js';
import { LineTransport } from './src/transport.js';

const logger = createLogger({
  service: 'task1-mcp-server',
  level: parseLogLevel(process.env.LOG_LEVEL),
});
const server = createServer({
  logger,
  tools: createTools(createMockCustomerRepository(), logger),
});
const transport = new LineTransport(process.stdin, process.stdout);

server.onclose = () => logger.info('server closed');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutting down', { signal });
    void server.close();
  });
}

await server.connect(transport);
logger.info('server started', { pid: process.pid });
