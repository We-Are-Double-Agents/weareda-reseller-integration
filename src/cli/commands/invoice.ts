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
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliContext, ParsedArgs } from '../context.js';
import { buildInvoiceIssuedEvent } from '../../weareda/events.js';
import type { Invoice } from '../../weareda/types.js';
import { isoTimestamp } from '../../lib/ids.js';
import { log } from '../../lib/logger.js';

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
