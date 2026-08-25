#!/usr/bin/env node
/**
 * WeAreDA reseller sandbox CLI.
 *
 * Everything in here is the RESELLER -> WEAREDA direction: signed webhook
 * events, plus the X-Reseller-Key read API.
 *
 *   npm run cli -- <command> [args] [--dry-run] [--event-id evt_...]
 *
 * With WEAREDA_WEBHOOK_URL / WEAREDA_WEBHOOK_SECRET unset, every webhook
 * command runs in DRY RUN mode: the signed request is printed but not sent, so
 * the CLI is useful before your integration is connected.
 *
 * Secrets are never printed - credentials are masked in every log block.
 */
import { createContext, parseArgs } from './context.js';
import { stockCommand } from './commands/stock.js';
import { orderStatusCommand } from './commands/order-status.js';
import { productUpdateCommand } from './commands/product-update.js';
import { invoiceCommand } from './commands/invoice.js';
import {
  invoiceDocumentCommand,
  ordersGetCommand,
  ordersInvoicesCommand,
  ordersListCommand,
} from './commands/read-api.js';
import { banner, log } from '../lib/logger.js';
import { mask } from '../lib/redact.js';

const USAGE = `
WeAreDA Reseller Sandbox CLI  -  direction: Reseller -> WeAreDA

Webhook events (contract 6). One event type per HTTP request, always.

  stock <id> <qty> [<id> <qty> ...]     stock.updated    (contract 6.2)
        Simulates YOUR ERP recalculating inventory, then reports the new
        ABSOLUTE quantities in ONE batched event.
        "37" means "there are now 37" - never "add 37".
          npm run cli -- stock P-1001 37
          npm run cli -- stock P-1001 37 V-2001 5

  order-status <orderId> <state>        order.status     (contract 6.1)
        One event per transition, each with its own event id.
        Mapped: accepted|acknowledged|ack, fulfilled|completed|shipped|
                delivered, cancelled|canceled, rejected|failed|error.
        Any other value is sent as-is, to show the "not mapped" behaviour.
          npm run cli -- order-status SO-10001 shipped

  product-update <id...> | --all        product.updated  (contract 6.5)
        Catalog push. Same serializer as GET /products. Batches of <= 500.
        A push is partial: omitted products are NOT archived.
          npm run cli -- product-update --all
          npm run cli -- product-update P-1004 --status archived

  invoice <orderId>                     invoice.issued   (contract 6.3)
        document_url must be HTTPS and reachable by WeAreDA - run the tunnel
        and set PUBLIC_BASE_URL first.
          npm run cli -- invoice SO-10001

Reseller read API (contract 11) - authenticated with X-Reseller-Key, a
DIFFERENT mechanism from the webhook HMAC.

  orders:list [--status confirmed] [--limit 25] [--cursor ...]
  orders:get <orderId>
  orders:invoices <orderId>
  invoice:document <invoiceId>

Global flags:
  --dry-run          sign and print the request without sending it
  --event-id <id>    reuse a specific event id (to observe 200 {deduped:true})

Local inspection:
  GET /debug/orders | /debug/products | /debug/events   (on the running server)
`;

type CommandHandler = (
  ctx: ReturnType<typeof createContext>,
  args: ReturnType<typeof parseArgs>,
) => Promise<number>;

const COMMANDS: Record<string, CommandHandler> = {
  stock: stockCommand,
  'order-status': orderStatusCommand,
  'product-update': productUpdateCommand,
  invoice: invoiceCommand,
  'orders:list': ordersListCommand,
  'orders:get': ordersGetCommand,
  'orders:invoices': ordersInvoicesCommand,
  'invoice:document': invoiceDocumentCommand,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    log.plain(USAGE);
    process.exit(command ? 0 : 1);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    log.plain(`Unknown command: ${command}`);
    log.plain(USAGE);
    process.exit(1);
  }

  const ctx = createContext();
  const isWebhookCommand = ['stock', 'order-status', 'product-update', 'invoice'].includes(command);

  if (isWebhookCommand && !ctx.webhook.configured) {
    banner([
      'DRY RUN MODE',
      '',
      'WEAREDA_WEBHOOK_URL and/or WEAREDA_WEBHOOK_SECRET are not set, so the',
      'request below is signed and printed but NOT sent.',
      '',
      `WEAREDA_WEBHOOK_URL    = ${ctx.config.webhook.url || '(not set)'}`,
      `WEAREDA_WEBHOOK_SECRET = ${mask(ctx.config.webhook.secret)}`,
      '',
      'Both values come from the WeAreDA connect response / your integration',
      'configuration. Fill them into .env to send for real.',
    ]);
  }

  try {
    const exitCode = await handler(ctx, parseArgs(rest));
    ctx.close();
    process.exit(exitCode);
  } catch (error) {
    ctx.close();
    log.plain('');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
