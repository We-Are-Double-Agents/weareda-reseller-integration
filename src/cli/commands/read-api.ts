/**
 * Reseller read API commands - contract 11.
 *
 * Direction: Reseller -> WeAreDA management API.
 *
 * A THIRD authentication context, distinct from both the inbound connector
 * credentials and the outbound webhook HMAC:
 *
 *     X-Reseller-Key: rsk_...
 *
 * Commands:
 *   npm run cli -- orders:list [--status confirmed] [--limit 25] [--cursor ...]
 *   npm run cli -- orders:get <orderId>
 *   npm run cli -- orders:invoices <orderId>
 *   npm run cli -- invoice:document <invoiceId>
 */
import type { CliContext, ParsedArgs } from '../context.js';
import type {
  OrderListFilters,
  ReadApiOrderDetail,
  ReadApiOrderList,
  ReadApiOrderListCustomer,
  ReadApiResponse,
} from '../../weareda/reseller-api-client.js';
import { log, RULE } from '../../lib/logger.js';
import { mask, maskTaxId, maskTaxIds, maskUrl } from '../../lib/redact.js';

export async function ordersListCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const filters: OrderListFilters = {};
  for (const key of [
    'status',
    'paymentStatus',
    'integrationStatus',
    'externalOrderId',
    'customerId',
    'email',
    'createdFrom',
    'createdTo',
    'updatedFrom',
    'updatedTo',
    'search',
    'cursor',
  ] as const) {
    const value = args.flags[key];
    if (typeof value === 'string') filters[key] = value;
  }
  if (typeof args.flags.limit === 'string') filters.limit = Number.parseInt(args.flags.limit, 10);
  if (args.flags.hasInvoice !== undefined) filters.hasInvoice = args.flags.hasInvoice === 'true';

  return run(
    ctx,
    () => ctx.readApi.listOrders(filters),
    (body) => summarizeCustomers((body as ReadApiOrderList).items ?? []),
  );
}

export async function ordersGetCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const [orderId] = args.positionals;
  if (!orderId) {
    log.plain('Usage: npm run cli -- orders:get <orderId>');
    return 1;
  }
  return run(
    ctx,
    () => ctx.readApi.getOrder(orderId),
    (body) => summarizeCustomers([body as ReadApiOrderDetail]),
  );
}

export async function ordersInvoicesCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const [orderId] = args.positionals;
  if (!orderId) {
    log.plain('Usage: npm run cli -- orders:invoices <orderId>');
    return 1;
  }
  return run(ctx, () => ctx.readApi.listOrderInvoices(orderId));
}

export async function invoiceDocumentCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const [invoiceId] = args.positionals;
  if (!invoiceId) {
    log.plain('Usage: npm run cli -- invoice:document <invoiceId>');
    return 1;
  }
  return run(ctx, () => ctx.readApi.getInvoiceDocument(invoiceId));
}

/**
 * Prints the customer of each returned order, with the fiscal identifier
 * masked (contract 11.8 asks integrators to treat it the way WeAreDA does).
 *
 * Note the CASING: this plane is camelCase - `taxId`, `firstName` - while the
 * order WeAreDA pushes to us is snake_case `tax_id`, `first_name`. Same data,
 * two conventions.
 */
function summarizeCustomers(
  orders: Array<{ id?: string; customer?: ReadApiOrderListCustomer }>,
): void {
  if (orders.length === 0) return;
  log.plain('');
  log.plain('Customers (contract 11.3 / 11.4, fiscal ids masked):');
  for (const order of orders) {
    const customer = order.customer;
    if (!customer) {
      // Ordinary: the order has no contact at all (contract 4.3).
      log.plain(`  ${order.id ?? '(no id)'}: (no customer object)`);
      continue;
    }
    const taxId = customer.taxId;
    const fiscal = taxId
      ? `${taxId.type} ${maskTaxId(taxId.value)}${taxId.country ? ` (${taxId.country})` : ''}`
      : '(no fiscal id - normal, and not an error)';
    log.plain(`  ${order.id ?? '(no id)'}: ${customer.name ?? '(unnamed)'} - ${fiscal}`);
  }
}

async function run(
  ctx: CliContext,
  call: () => Promise<ReadApiResponse>,
  summarize?: (body: unknown) => void,
): Promise<number> {
  log.plain(RULE);
  log.plain('READ API REQUEST');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain('Authentication:');
  log.plain(`X-Reseller-Key: ${mask(ctx.config.managementApi.resellerKey)}`);
  log.plain('(NOT the webhook HMAC, and NOT the inbound connector key)');
  log.plain('');
  log.plain(`Tenant: ${ctx.config.managementApi.tenantId || '(WEAREDA_TENANT_ID not set)'}`);

  try {
    const response = await call();
    log.plain('');
    log.plain(`${response.method} ${maskUrl(response.url)}`);
    log.plain('');
    log.plain('Response:');
    log.plain(`${response.statusCode} ${response.statusText}`);
    // Everything else is printed verbatim; customer.taxId is masked, because a
    // fiscal identifier does not belong in a terminal scrollback (11.8).
    log.plain(JSON.stringify(maskTaxIds(response.body), null, 2));
    if (response.ok && summarize) summarize(response.body);
    log.plain(RULE);
    return response.ok ? 0 : 1;
  } catch (error) {
    log.plain('');
    log.plain(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    log.plain(RULE);
    return 1;
  }
}
