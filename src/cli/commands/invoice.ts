/**
 * `cli invoice <orderId> [--invoice-id INV-...] [--number A-0007] [--status paid] [--total 105.00]`
 *
 * Direction: Reseller -> WeAreDA (contract 6.3).
 *
 * `document_url` must serve a PDF over HTTPS that WeAreDA can fetch, and its
 * host must be allow-listed via sync_config.documentHosts. Locally that means
 * running `npm run tunnel` and setting PUBLIC_BASE_URL to the tunnel URL - the
 * sandbox then points the invoice at
 *   https://<tunnel-host>/fixtures/invoices/demo.pdf
 * which it serves itself, so the whole document-fetch flow can be tested.
 *
 * Re-sending the same external_invoice_id UPDATES the invoice in place.
 * An invoice never moves the order's status and never touches stock.
 *
 * ============================================================================
 * WHAT THE ORDER'S FISCAL IDENTITY IS FOR (contract 4.3)
 * ============================================================================
 * This is the flow the `customer` object exists for. The invoice is issued
 * against the identity the ORDER was created with - a snapshot (4.3.1), not a
 * live read of the contact. If the tenant corrects the contact tomorrow, this
 * invoice keeps the identity it was issued under, and only NEW orders carry
 * the new value. Never "refresh" a stored order from a later read.
 *
 * An order with no fiscal id is an ordinary order, not an error. If your
 * billing cannot issue without one, the fix is
 * `syncConfig.orders.requiresTaxId: true` (4.3.2) - WeAreDA then holds the
 * order back until the tenant completes the contact - never a rejection of the
 * delivery.
 *
 * The invoice.issued event itself carries NO customer: WeAreDA already holds
 * the snapshot and links the invoice by external_order_id / order_number.
 * ============================================================================
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliContext, ParsedArgs } from '../context.js';
import { buildInvoiceIssuedEvent } from '../../weareda/events.js';
import type { Invoice } from '../../weareda/types.js';
import { customerOf, taxIdOf } from '../../weareda/types.js';
import type { StoredOrder } from '../../services/order-service.js';
import { isoTimestamp } from '../../lib/ids.js';
import { log } from '../../lib/logger.js';
import { maskTaxId } from '../../lib/redact.js';

interface InvoiceFixture {
  external_invoice_id: string;
  number: string;
  status: string;
  currency: string;
  total: number;
  issued_at: string;
  document_file: string;
}

export async function invoiceCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const [orderReference] = args.positionals;

  if (!orderReference) {
    log.plain('Usage: npm run cli -- invoice <orderId> [--invoice-id ...] [--status paid]');
    return 1;
  }

  const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), 'fixtures/invoices/demo-invoice.json'), 'utf8'),
  ) as InvoiceFixture;

  const order = ctx.orders.findById(orderReference) ?? ctx.orders.findByOrderNumber(orderReference);

  const documentUrl = `${ctx.publicBaseUrl}/fixtures/invoices/${fixture.document_file}`;
  const isHttps = documentUrl.startsWith('https://');

  const invoice: Invoice = {
    external_invoice_id: stringFlag(args, 'invoice-id') ?? fixture.external_invoice_id,
    number: stringFlag(args, 'number') ?? fixture.number,
    status: stringFlag(args, 'status') ?? fixture.status,
    currency: stringFlag(args, 'currency') ?? order?.currency ?? fixture.currency,
    total: numberFlag(args, 'total') ?? fixture.total,
    issued_at: stringFlag(args, 'issued-at') ?? isoTimestamp(),
    ...(order ? { external_order_id: order.id } : { external_order_id: orderReference }),
    ...(order?.order_number ? { order_number: order.order_number } : {}),
    document_url: documentUrl,
  };

  log.plain('');
  if (!order) {
    log.plain(
      `No local order matches "${orderReference}" - sending the invoice against it anyway.`,
    );
  } else {
    printFiscalIdentity(order);
  }
  log.plain(`document_url: ${documentUrl}`);
  if (!isHttps) {
    log.plain('');
    log.plain('WARNING: that URL is not HTTPS, so WeAreDA cannot fetch it.');
    log.plain('         The invoice would still be recorded, with document_status "failed".');
    log.plain('         Run `npm run tunnel` and set PUBLIC_BASE_URL to the tunnel URL.');
  }

  const event = buildInvoiceIssuedEvent(invoice, stringFlag(args, 'event-id'));
  const result = await ctx.webhook.send(event, { dryRun: args.flags['dry-run'] === true });

  return result.dryRun || result.ok ? 0 : 1;
}

/**
 * Shows who this invoice is being issued against, with the identifier masked -
 * a fiscal id belongs in your billing system, not in a terminal scrollback
 * (contract 11.8).
 */
function printFiscalIdentity(order: StoredOrder): void {
  const customer = customerOf(order.payload);
  const taxId = taxIdOf(order.payload);

  log.plain('Invoicing against (contract 4.3, a snapshot taken when the order was created):');
  log.plain(`  Order:    ${order.id}${order.order_number ? ` (${order.order_number})` : ''}`);

  if (!customer) {
    // The order simply has no contact. Nothing is wrong, and nothing is missing.
    log.plain('  Customer: (this order carries no customer object)');
  } else {
    log.plain(`  Customer: ${customer.name ?? '(unnamed)'}`);
  }

  if (taxId) {
    // The type token is printed exactly as it arrived, whatever it was.
    log.plain(
      `  Tax id:   ${taxId.type} ${maskTaxId(taxId.value)}` +
        `${taxId.country ? ` (${taxId.country})` : ''}`,
    );
    log.plain('            Stored in full locally; masked here and in every log.');
  } else {
    log.plain('  Tax id:   (none)');
    log.plain('');
    log.plain('  NOTE: this order carries no fiscal identification, which is NORMAL and');
    log.plain('        not an error - customer.tax_id is null when the contact has none.');
    log.plain('        The order was accepted, as it must be: rejecting it would only');
    log.plain('        route it to manual_review (contract 4.3).');
    log.plain('        If you cannot invoice without one, set');
    log.plain('          syncConfig.orders.requiresTaxId: true   (contract 4.3.2)');
    log.plain('          npm run cli -- integration:connect --requires-tax-id');
    log.plain('        and WeAreDA holds such orders back until the tenant completes the');
    log.plain('        contact, delivering them automatically within a minute.');
    log.plain('        The absence is not permanent: an order delivered without a fiscal');
    log.plain('        id can start reporting one later (contract 4.3.1).');
  }
  log.plain('');
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
