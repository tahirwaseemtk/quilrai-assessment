import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { CaptureSink } from '../../shared/test/helpers/capture-sink.js';
import { createMockDownstream, type MockDownstream } from '../mock-downstream/server.js';
import {
  DOWNSTREAM_TOKEN,
  LIST,
  startGateway,
  stopGateways,
  VIEWER_TOKEN,
} from './helpers/gateway-harness.js';
import { bearer, postRpc } from './helpers/mcp-http.js';

const mocks: MockDownstream[] = [];

async function startMock(jsonResponse = true) {
  const mock = createMockDownstream({
    authToken: DOWNSTREAM_TOKEN,
    logger: createLogger({ service: 'mock-downstream', sink: new CaptureSink() }),
    jsonResponse,
  });
  mocks.push(mock);
  return { mock, url: (await mock.listen()).url };
}

afterEach(async () => {
  await stopGateways();
  await Promise.all(mocks.splice(0).map((mock) => mock.close()));
});

const raw = { raw: true };
const toolNames = (json: unknown) =>
  (json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);

describe('gateway in front of the real mock downstream', () => {
  it('passes tools/list through unchanged (JSON mode)', async () => {
    const { url: mockUrl } = await startMock();
    const { url } = await startGateway({ downstreamUrl: mockUrl });
    const viaGateway = await postRpc(url, LIST, bearer(VIEWER_TOKEN), raw);
    const direct = await postRpc(mockUrl, LIST, bearer(DOWNSTREAM_TOKEN), raw);
    expect(viaGateway.status).toBe(direct.status);
    expect(viaGateway.headers.get('content-type')).toBe(direct.headers.get('content-type'));
    expect(viaGateway.text).toBe(direct.text);
    expect(toolNames(viaGateway.json)).toEqual(['get_status', 'admin_reset_key', 'admin']);
  });

  it('streams an SSE tools/list through', async () => {
    const { url: mockUrl } = await startMock(false);
    const { url } = await startGateway({ downstreamUrl: mockUrl });
    const response = await postRpc(url, LIST, bearer(VIEWER_TOKEN), raw);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const data = response.text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    expect(toolNames(JSON.parse(data ?? 'null'))).toEqual([
      'get_status',
      'admin_reset_key',
      'admin',
    ]);
  });

  it('never forwards the client token: the mock only accepts the gateway credential', async () => {
    const { url: mockUrl } = await startMock();
    const { url } = await startGateway({ downstreamUrl: mockUrl });
    expect((await postRpc(url, LIST, bearer(VIEWER_TOKEN), raw)).status).toBe(200);
    expect((await postRpc(mockUrl, LIST, bearer(VIEWER_TOKEN), raw)).status).toBe(401);
  });
});
