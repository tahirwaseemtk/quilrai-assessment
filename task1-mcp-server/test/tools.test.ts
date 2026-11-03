import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RpcError } from '../src/errors.js';
import { ArgumentMessage } from '../src/field-errors.js';
import {
  createMockCustomerRepository,
  type CustomerRepository,
} from '../src/customer-repository.js';
import { createLogger } from '../../shared/logger.js';
import { GetCustomerRecordArgs, TriggerRefundArgs } from '../src/schemas.js';
import { runTool, type ToolDefinition } from '../src/server.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../src/tool-schemas.js';
import { FailureMessage, createTools } from '../src/tools.js';
import { CaptureSink } from './helpers/streams.js';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);

type CallableTool = Omit<ToolDefinition, 'handler'> & {
  handler: (args: unknown) => Promise<CallToolResult>;
};

function setup(repository: CustomerRepository = createMockCustomerRepository()) {
  const sink = new CaptureSink();
  const logger = createLogger({ service: 'test', sink, level: 'debug' });
  const tools = createTools(repository, logger);
  // Call through runTool, as the server does, so argument validation is part of every test.
  const byName = (name: string): CallableTool => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return { ...tool, handler: (args) => runTool(tool, args) };
  };
  return {
    tools,
    sink,
    get: byName('get_customer_record'),
    refund: byName('trigger_refund'),
  };
}

function spyRepository(): CustomerRepository & { calls: number } {
  const inner = createMockCustomerRepository();
  const spy = {
    calls: 0,
    find: (id: string) => {
      spy.calls += 1;
      return inner.find(id);
    },
    refund: (id: string, cents: number, reason: string) => {
      spy.calls += 1;
      return inner.refund(id, cents, reason);
    },
  };
  return spy;
}

const refundArgs = (overrides: Record<string, unknown> = {}) => ({
  customer_id: 'CUST-00001',
  amount: 50,
  reason: 'Damaged on arrival',
  ...overrides,
});

describe('tool definitions', () => {
  it('defines both tools with their published schemas', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(['get_customer_record', 'trigger_refund']);
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(20);
    expect(tools[0]?.inputSchema).toBe(getCustomerRecordInputSchema);
    expect(tools[1]?.inputSchema).toBe(triggerRefundInputSchema);
    expect(tools[0]?.args).toBe(GetCustomerRecordArgs);
    expect(tools[1]?.args).toBe(TriggerRefundArgs);
  });

  it('gives every tool a strict argument schema', () => {
    for (const tool of setup().tools) {
      expect(tool.args.safeParse({ unexpected: 1 }).success, tool.name).toBe(false);
      expect(tool.args.safeParse(undefined).success, tool.name).toBe(false);
    }
  });

  it('annotates read-only and destructive behavior exactly', () => {
    const { get, refund } = setup();
    expect(get.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(refund.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe('get_customer_record', () => {
  it('returns the record as text and structured content', async () => {
    const { get } = setup();
    const result = await get.handler({ customer_id: 'CUST-00001' });
    expect(result.structuredContent).toMatchObject({
      customer_id: 'CUST-00001',
      refundable_balance: 250,
    });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(result).not.toHaveProperty('isError');
  });

  it('still returns a closed account', async () => {
    const { get } = setup();
    const result = await get.handler({ customer_id: 'CUST-00003' });
    expect(result.structuredContent).toMatchObject({ status: 'closed' });
    expect(result).not.toHaveProperty('isError');
  });
});

describe('trigger_refund', () => {
  it.each([
    [0.01, 249.99],
    [0.29, 249.71],
    [1.15, 248.85],
    [19.99, 230.01],
    [250, 0],
  ])('refunds %d and leaves %d', async (amount, remaining) => {
    const { refund } = setup();
    const result = await refund.handler(refundArgs({ amount }));
    expect(result.structuredContent).toEqual({
      refund_id: 'REF-000001',
      customer_id: 'CUST-00001',
      amount,
      reason: 'Damaged on arrival',
      remaining_balance: remaining,
      status: 'processed',
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    );
  });

  it('accepts the maximum amount', async () => {
    const { refund } = setup();
    const result = await refund.handler(refundArgs({ customer_id: 'CUST-00004', amount: 10_000 }));
    expect(result.structuredContent).toMatchObject({ remaining_balance: 0 });
  });

  it('stores and echoes the normalized reason', async () => {
    const family = `Family ${char(0x1f468)}${char(0x200d)}${char(0x1f469)} plan billed twice`;
    const { refund } = setup();
    const trimmed = await refund.handler(refundArgs({ reason: '  Damaged on arrival  ' }));
    expect(trimmed.structuredContent).toMatchObject({ reason: 'Damaged on arrival' });
    const kept = await setup().refund.handler(refundArgs({ reason: family }));
    expect(kept.structuredContent).toMatchObject({ reason: family });
  });
});

describe('business failures', () => {
  it.each([
    ['get_customer_record', { customer_id: 'CUST-99999' }, FailureMessage.not_found],
    ['trigger_refund', refundArgs({ customer_id: 'CUST-99999' }), FailureMessage.not_found],
    ['trigger_refund', refundArgs({ customer_id: 'CUST-00003' }), FailureMessage.account_closed],
    [
      'trigger_refund',
      refundArgs({ customer_id: 'CUST-00002', amount: 0.01 }),
      FailureMessage.insufficient_balance,
    ],
    ['trigger_refund', refundArgs({ amount: 250.01 }), FailureMessage.insufficient_balance],
  ])('%s %j returns isError "%s"', async (name, args, message) => {
    const tools = setup();
    const tool = name === 'get_customer_record' ? tools.get : tools.refund;
    expect(await tool.handler(args)).toEqual({
      isError: true,
      content: [{ type: 'text', text: message }],
    });
  });

  it('uses fixed failure messages', () => {
    expect(FailureMessage).toEqual({
      not_found: 'Customer not found',
      account_closed: 'Customer account is closed',
      insufficient_balance: 'Refund amount exceeds refundable balance',
    });
  });
});

describe('invalid arguments', () => {
  const P = 'Invalid params: ';
  const M = ArgumentMessage;

  it.each([
    [undefined, P + M.CustomerIdRequired],
    [{}, P + M.CustomerIdRequired],
    [{ customer_id: 'cust-00001' }, P + M.CustomerId],
    [{ customer_id: 'CUST-00001', extra: 1 }, P + M.UnknownArguments],
    [null, P + M.NotAnObject],
  ])('get_customer_record rejects %j with %j', async (args, message) => {
    const repository = spyRepository();
    const { get } = setup(repository);
    await expect(get.handler(args)).rejects.toEqual(new RpcError(-32602, message));
    expect(repository.calls).toBe(0);
  });

  it.each([
    [undefined, P + [M.CustomerIdRequired, M.AmountRequired, M.ReasonRequired].join('; ')],
    [{}, P + [M.CustomerIdRequired, M.AmountRequired, M.ReasonRequired].join('; ')],
    [refundArgs({ amount: 0 }), P + M.Amount],
    [refundArgs({ amount: 0.001 }), P + M.Amount],
    [refundArgs({ amount: '10' }), P + M.Amount],
    [refundArgs({ amount: NaN }), P + M.Amount],
    [refundArgs({ reason: 'short' }), P + M.Reason],
    [{ customer_id: 'CUST-00001', amount: 50 }, P + M.ReasonRequired],
  ])('trigger_refund rejects %j with %j', async (args, message) => {
    const repository = spyRepository();
    const { refund } = setup(repository);
    const error = await refund.handler(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32602, message });
    expect((error as Error).message).not.toMatch(
      /issues|Zod|expected|received|invalid_type|too_small/,
    );
    expect(error).not.toHaveProperty('cause');
    expect(repository.calls).toBe(0);
  });
});

describe('repository failures', () => {
  it('lets an unexpected repository error propagate for the server to mask', async () => {
    const broken: CustomerRepository = {
      find: () => {
        throw new Error('db C:\\secret');
      },
      refund: vi.fn(),
    };
    const { get } = setup(broken);
    const error = await get.handler({ customer_id: 'CUST-00001' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RpcError);
  });
});

describe('refund logging', () => {
  const sentinel = 'Contact jane.doe@example.com about SSN 123-45-6789';

  it('logs only the customer, refund id and amount on success', async () => {
    const { refund, sink } = setup();
    await refund.handler(refundArgs({ reason: sentinel }));
    const entries = sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      ['amount', 'customer_id', 'level', 'msg', 'refund_id', 'service', 'time'].sort(),
    );
    expect(entries[0]).toMatchObject({
      level: 'info',
      customer_id: 'CUST-00001',
      refund_id: 'REF-000001',
      amount: 50,
    });
    const text = sink.chunks.join('');
    expect(text).not.toContain('jane.doe');
    expect(text).not.toContain('123-45-6789');
  });

  it('logs failures with the customer and failure code only', async () => {
    const { refund, sink } = setup();
    await refund.handler(refundArgs({ amount: 250.01, reason: sentinel }));
    await refund.handler(refundArgs({ amount: 0, reason: sentinel })).catch(() => undefined);
    const entries = sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'info',
        customer_id: 'CUST-00001',
        failure: 'insufficient_balance',
      }),
    ]);
    expect(sink.chunks.join('')).not.toContain('jane.doe');
  });
});
