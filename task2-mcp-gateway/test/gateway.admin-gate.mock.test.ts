import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { createMockDownstream, type MockDownstream } from '../mock-downstream/server.js';
import {
  ADMIN_TOKEN,
  DOWNSTREAM_TOKEN,
  rpcErrorBody,
  startGateway,
  stopGateways,
  VIEWER_TOKEN,
} from './helpers/gateway-harness.js';
import { bearer, postRpc } from './helpers/mcp-http.js';

const mocks: MockDownstream[] = [];

async function setup() {
  const mock = createMockDownstream({
    authToken: DOWNSTREAM_TOKEN,
    logger: createLogger({ service: 'mock-downstream', sink: new CaptureSink() }),
  });
  mocks.push(mock);
  const { url: downstreamUrl } = await mock.listen();
  const { url } = await startGateway({ downstreamUrl });
  const call = (token: string, id: number, name: string, args?: unknown) =>
    postRpc(
      url,
      {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, ...(args === undefined ? {} : { arguments: args }) },
      },
      bearer(token),
    );
  return { mock, call };
}

afterEach(async () => {
  await stopGateways();
  await Promise.all(mocks.splice(0).map((mock) => mock.close()));
});

const resultText = (json: unknown): unknown =>
  JSON.parse(
    (json as { result: { content: { text: string }[] } }).result.content[0]?.text ?? 'null',
  );

describe('admin gate in front of the real mock downstream', () => {
  it('lets a viewer call get_status', async () => {
    const { mock, call } = await setup();
    const response = await call(VIEWER_TOKEN, 1, 'get_status');
    expect(response.status).toBe(200);
    expect(resultText(response.json)).toEqual({ status: 'ok' });
    expect(mock.calls).toEqual([{ name: 'get_status', arguments: {} }]);
  });

  it('denies a viewer the admin tools and the downstream executes nothing', async () => {
    const { mock, call } = await setup();
    const reset = await call(VIEWER_TOKEN, 2, 'admin_reset_key', { key_id: 'k-1' });
    const admin = await call(VIEWER_TOKEN, 3, 'admin');
    expect(reset.text).toBe(rpcErrorBody(2, -32001, 'Unauthorized Tool Call'));
    expect(admin.text).toBe(rpcErrorBody(3, -32001, 'Unauthorized Tool Call'));
    expect(mock.calls).toEqual([]);
  });

  it('lets an admin reach both admin tools', async () => {
    const { mock, call } = await setup();
    const reset = await call(ADMIN_TOKEN, 2, 'admin_reset_key', { key_id: 'k-1' });
    const admin = await call(ADMIN_TOKEN, 3, 'admin');
    expect(resultText(reset.json)).toEqual({ reset: true, key_id: 'k-1' });
    expect(resultText(admin.json)).toEqual({ admin: true });
    expect(mock.calls.map((record) => record.name)).toEqual(['admin_reset_key', 'admin']);
  });

  it('never lets an invalid name reach the mock', async () => {
    const { mock, call } = await setup();
    for (const token of [VIEWER_TOKEN, ADMIN_TOKEN]) {
      for (const name of ['', 'a b']) {
        const response = await call(token, 1, name);
        expect(response.text).toBe(rpcErrorBody(1, -32602, 'Invalid params'));
      }
    }
    expect(mock.calls).toEqual([]);
  });

  it('relays the mock own error for an unknown but valid name', async () => {
    const { mock, call } = await setup();
    const response = await call(VIEWER_TOKEN, 1, 'nope');
    expect(response.json).toMatchObject({
      id: 1,
      error: { code: -32602, message: 'Unknown tool' },
    });
    expect(mock.calls).toEqual([]);
  });
});
