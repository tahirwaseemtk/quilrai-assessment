import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CustomerRepository, RefundFailure } from './customer-repository.js';
import { ArgumentMessage, type ArgumentField } from './field-errors.js';
import type { Logger } from './logger.js';
import { GetCustomerRecordArgs, TriggerRefundArgs } from './schemas.js';
import { defineTool, type ToolDefinition } from './server.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from './tool-schemas.js';

const customerIdField: ArgumentField = {
  name: 'customer_id',
  invalid: ArgumentMessage.CustomerId,
  required: ArgumentMessage.CustomerIdRequired,
};

export const customerRecordFields: readonly ArgumentField[] = [customerIdField];

export const refundFields: readonly ArgumentField[] = [
  customerIdField,
  { name: 'amount', invalid: ArgumentMessage.Amount, required: ArgumentMessage.AmountRequired },
  { name: 'reason', invalid: ArgumentMessage.Reason, required: ArgumentMessage.ReasonRequired },
];

export const FailureMessage: Readonly<Record<RefundFailure, string>> = {
  not_found: 'Customer not found',
  account_closed: 'Customer account is closed',
  insufficient_balance: 'Refund amount exceeds refundable balance',
};

function success(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

// Business outcomes, not protocol errors: the call was valid, so the client gets a tool result
// it can show to the model (MCP isError) rather than a JSON-RPC error.
function failure(reason: RefundFailure): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: FailureMessage[reason] }] };
}

export function createTools(repository: CustomerRepository, logger: Logger): ToolDefinition[] {
  return [
    defineTool({
      name: 'get_customer_record',
      description:
        'Look up a customer by id (CUST-XXXXX) and return their name, email, account status and refundable balance in USD.',
      inputSchema: getCustomerRecordInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      args: GetCustomerRecordArgs,
      argumentFields: customerRecordFields,
      handler: ({ customer_id }) => {
        const customer = repository.find(customer_id);
        return customer ? success(customer) : failure('not_found');
      },
    }),
    defineTool({
      name: 'trigger_refund',
      description:
        "Refund an amount in USD to an active customer's account, up to their refundable balance. Every call creates a new refund.",
      inputSchema: triggerRefundInputSchema,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
      args: TriggerRefundArgs,
      argumentFields: refundFields,
      handler: ({ customer_id, amount, reason }) => {
        // The schema guarantees at most 2 decimals; rounding removes float noise from * 100.
        const outcome = repository.refund(customer_id, Math.round(amount * 100), reason);
        if (!outcome.ok) {
          logger.info('refund rejected', { customer_id, failure: outcome.reason });
          return failure(outcome.reason);
        }
        // The reason is free text and may contain personal data, so it is never logged.
        const { refund } = outcome;
        logger.info('refund processed', {
          customer_id,
          refund_id: refund.refund_id,
          amount: refund.amount,
        });
        return success(refund);
      },
    }),
  ];
}
