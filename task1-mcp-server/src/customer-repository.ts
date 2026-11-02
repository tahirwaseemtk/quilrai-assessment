export type CustomerStatus = 'active' | 'closed';

export type CustomerSeed = {
  customer_id: string;
  name: string;
  email: string;
  status: CustomerStatus;
  balance_cents: number;
};

export type Customer = Omit<CustomerSeed, 'balance_cents'> & {
  refundable_balance: number;
  currency: 'USD';
};

export type Refund = {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  remaining_balance: number;
  status: 'processed';
};

export type RefundFailure = 'not_found' | 'account_closed' | 'insufficient_balance';

export type RefundOutcome = { ok: true; refund: Refund } | { ok: false; reason: RefundFailure };

export interface CustomerRepository {
  find(customerId: string): Customer | undefined;
  refund(customerId: string, amountCents: number, reason: string): RefundOutcome;
}

export interface MockRepositoryOptions {
  customers?: readonly CustomerSeed[];
  nextRefundId?: () => string;
}

export const DEFAULT_CUSTOMERS: readonly CustomerSeed[] = Object.freeze([
  {
    customer_id: 'CUST-00001',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    status: 'active',
    balance_cents: 25_000,
  },
  {
    customer_id: 'CUST-00002',
    name: 'Alan Turing',
    email: 'alan@example.com',
    status: 'active',
    balance_cents: 0,
  },
  {
    customer_id: 'CUST-00003',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    status: 'closed',
    balance_cents: 10_000,
  },
  {
    customer_id: 'CUST-00004',
    name: 'Katherine Johnson',
    email: 'katherine@example.com',
    status: 'active',
    balance_cents: 1_000_000,
  },
]);

const toDollars = (cents: number): number => cents / 100;

function sequentialRefundIds(): () => string {
  let next = 1;
  return () => `REF-${String(next++).padStart(6, '0')}`;
}

// In-memory and per instance: state lives for one server process. Balances are integer cents
// so repeated refunds never accumulate floating-point error.
export function createMockCustomerRepository(
  options: MockRepositoryOptions = {},
): CustomerRepository {
  const customers = new Map(
    (options.customers ?? DEFAULT_CUSTOMERS).map((seed) => [seed.customer_id, { ...seed }]),
  );
  const nextRefundId = options.nextRefundId ?? sequentialRefundIds();

  return {
    find(customerId) {
      const stored = customers.get(customerId);
      if (!stored) return undefined;
      const { balance_cents, ...fields } = stored;
      return { ...fields, refundable_balance: toDollars(balance_cents), currency: 'USD' };
    },

    refund(customerId, amountCents, reason) {
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error(`refund amount must be a positive whole number of cents`);
      }
      // The balance check and the debit must stay in one synchronous step: an await between
      // them would let pipelined refunds overdraw the account.
      const stored = customers.get(customerId);
      if (!stored) return { ok: false, reason: 'not_found' };
      if (stored.status === 'closed') return { ok: false, reason: 'account_closed' };
      if (amountCents > stored.balance_cents) return { ok: false, reason: 'insufficient_balance' };

      stored.balance_cents -= amountCents;
      return {
        ok: true,
        refund: {
          refund_id: nextRefundId(),
          customer_id: customerId,
          amount: toDollars(amountCents),
          reason,
          remaining_balance: toDollars(stored.balance_cents),
          status: 'processed',
        },
      };
    },
  };
}
