import { createLogger } from '../../../shared/logger.js';
import { CaptureSink } from '../../../shared/test/helpers/capture-sink.js';
import { createGateway, type Gateway } from '../../src/gateway.js';
import { parseTokenConfig } from '../../src/token-config.js';
import { ACCEPT_MCP } from './mcp-http.js';
import type { RawHeaders } from './raw-http.js';

export const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
export const VIEWER_TOKEN = 'viewer-token-0123456789abcdef';
export const DOWNSTREAM_TOKEN = 'downstream-token-0123456789';
export const LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';

const tokens = parseTokenConfig(
  JSON.stringify({ [ADMIN_TOKEN]: 'admin', [VIEWER_TOKEN]: 'viewer' }),
);
if (!tokens.ok) throw new Error('test token table is invalid');

export interface StartedGateway {
  gateway: Gateway;
  url: string;
  port: number;
  sink: CaptureSink;
}

const running: Gateway[] = [];

export async function startGateway(options: {
  downstreamUrl: string;
  timeoutMs?: number;
}): Promise<StartedGateway> {
  const sink = new CaptureSink();
  const gateway = createGateway({
    table: tokens.ok ? tokens.table : [],
    downstreamUrl: options.downstreamUrl,
    downstreamToken: DOWNSTREAM_TOKEN,
    timeoutMs: options.timeoutMs ?? 5000,
    logger: createLogger({ service: 'task2-mcp-gateway', sink }),
  });
  running.push(gateway);
  const { url, port } = await gateway.listen();
  return { gateway, url, port, sink };
}

export async function stopGateways(): Promise<void> {
  await Promise.all(running.splice(0).map((gateway) => gateway.close()));
}

export function stdHeaders(overrides: RawHeaders = {}, token = VIEWER_TOKEN): RawHeaders {
  return {
    'content-type': 'application/json',
    accept: ACCEPT_MCP,
    authorization: `Bearer ${token}`,
    ...overrides,
  };
}

export const rpcErrorBody = (id: unknown, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
