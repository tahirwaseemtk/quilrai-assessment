import { describe, expect, it } from 'vitest';
import { createMockCustomerRepository, type CustomerSeed } from '../src/customer-repository.js';

const reason = 'Damaged on arrival';

describe('mock customer repository: lookup', () => {
  it.each([
    ['CUST-00001', 'active', 250],
    ['CUST-00002', 'active', 0],
    ['CUST-00003', 'closed', 100],
    ['CUST-00004', 'active', 10_000],
  ])('seeds %s as %s with refundable balance %d', (id, status, balance) => {
    expect(createMockCustomerRepository().find(id)).toEqual({
      customer_id: id,
      name: expect.any(String) as string,
      email: expect.stringContaining('@') as string,
      status,
      refundable_balance: balance,
      currency: 'USD',
    });
  });

  it.each(['CUST-99999', 'CUST-00000'])('returns undefined for unknown %s', (id) => {
    expect(createMockCustomerRepository().find(id)).toBeUndefined();
  });

  it('returns copies that callers cannot use to change stored data', () => {
    const repository = createMockCustomerRepository();
    const record = repository.find('CUST-00001');
    if (!record) throw new Error('seed missing');
    record.refundable_balance = 0;
    record.status = 'closed';
    expect(repository.find('CUST-00001')).toMatchObject({
      refundable_balance: 250,
      status: 'active',
    });
  });

  it('copies a caller-supplied seed', () => {
    const seed: CustomerSeed = {
      customer_id: 'CUST-12345',
      name: 'Test',
      email: 't@example.com',
      status: 'active',
      balance_cents: 1000,
    };
    const customers = [seed];
    const repository = createMockCustomerRepository({ customers });
    seed.balance_cents = 1;
    customers.length = 0;
    expect(repository.find('CUST-12345')?.refundable_balance).toBe(10);
    repository.refund('CUST-12345', 500, reason);
    expect(seed.balance_cents).toBe(1);
  });

  it('isolates repositories built from the default seed', () => {
    const first = createMockCustomerRepository();
    first.refund('CUST-00001', 5000, reason);
    const second = createMockCustomerRepository();
    expect(first.find('CUST-00001')?.refundable_balance).toBe(200);
    expect(second.find('CUST-00001')?.refundable_balance).toBe(250);
  });
});

describe('mock customer repository: refunds', () => {
  it('processes a refund and reduces the balance', () => {
    const repository = createMockCustomerRepository();
    expect(repository.refund('CUST-00001', 5000, reason)).toEqual({
      ok: true,
      refund: {
        refund_id: 'REF-000001',
        customer_id: 'CUST-00001',
        amount: 50,
        reason,
        remaining_balance: 200,
        status: 'processed',
      },
    });
    expect(repository.find('CUST-00001')?.refundable_balance).toBe(200);
  });

  it('allows refunding the exact balance', () => {
    const outcome = createMockCustomerRepository().refund('CUST-00001', 25_000, reason);
    expect(outcome.ok && Object.is(outcome.refund.remaining_balance, 0)).toBe(true);
  });

  it('allows the maximum amount on a large balance', () => {
    const outcome = createMockCustomerRepository().refund('CUST-00004', 1_000_000, reason);
    expect(outcome).toMatchObject({ ok: true, refund: { amount: 10_000, remaining_balance: 0 } });
  });

  it.each([
    ['one cent over the balance', 'CUST-00001', 25_001, 'insufficient_balance'],
    ['a zero balance', 'CUST-00002', 1, 'insufficient_balance'],
    ['a closed account', 'CUST-00003', 100, 'account_closed'],
    ['a closed account over its balance', 'CUST-00003', 50_000, 'account_closed'],
    ['an unknown customer', 'CUST-99999', 100, 'not_found'],
  ])('rejects %s', (_label, id, cents, failure) => {
    const repository = createMockCustomerRepository();
    const before = repository.find(id)?.refundable_balance;
    expect(repository.refund(id, cents, reason)).toEqual({ ok: false, reason: failure });
    expect(repository.find(id)?.refundable_balance).toBe(before);
  });

  it('keeps cent arithmetic exact across repeated refunds', () => {
    const repository = createMockCustomerRepository({
      customers: [
        {
          customer_id: 'CUST-55555',
          name: 'Cents',
          email: 'c@example.com',
          status: 'active',
          balance_cents: 30,
        },
      ],
    });
    const remaining = [1, 2, 3].map((): unknown => {
      const outcome = repository.refund('CUST-55555', 10, reason);
      return outcome.ok ? outcome.refund.remaining_balance : outcome.reason;
    });
    expect(remaining).toEqual([0.2, 0.1, 0]);
    expect(repository.refund('CUST-55555', 10, reason)).toEqual({
      ok: false,
      reason: 'insufficient_balance',
    });
  });

  it.each([
    [29, 249.71],
    [115, 248.85],
    [1999, 230.01],
  ])('leaves an exact remainder after refunding %i cents', (cents, remaining) => {
    const outcome = createMockCustomerRepository().refund('CUST-00001', cents, reason);
    expect(outcome.ok ? outcome.refund.remaining_balance : undefined).toBe(remaining);
  });

  it('issues sequential ids and does not spend one on a failure', () => {
    const repository = createMockCustomerRepository();
    const ids = [5000, 25_001, 5000].map((cents) => {
      const outcome = repository.refund('CUST-00001', cents, reason);
      return outcome.ok ? outcome.refund.refund_id : outcome.reason;
    });
    expect(ids).toEqual(['REF-000001', 'insufficient_balance', 'REF-000002']);
  });

  it('uses an injected refund id generator', () => {
    const repository = createMockCustomerRepository({ nextRefundId: () => 'REF-TEST' });
    const outcome = repository.refund('CUST-00001', 100, reason);
    expect(outcome.ok ? outcome.refund.refund_id : undefined).toBe('REF-TEST');
  });

  it('keeps a separate id counter per repository', () => {
    const first = createMockCustomerRepository();
    first.refund('CUST-00001', 100, reason);
    first.refund('CUST-00001', 100, reason);
    const outcome = createMockCustomerRepository().refund('CUST-00001', 100, reason);
    expect(outcome.ok ? outcome.refund.refund_id : undefined).toBe('REF-000001');
  });

  it.each([0, -1, 1.5, NaN])('refuses %d cents as a programming error', (cents) => {
    const repository = createMockCustomerRepository();
    expect(() => repository.refund('CUST-00001', cents, reason)).toThrow(Error);
    expect(repository.find('CUST-00001')?.refundable_balance).toBe(250);
  });
});
