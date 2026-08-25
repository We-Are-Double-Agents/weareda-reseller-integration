/**
 * `cli product-update [productId ...] [--all] [--status archived] [--page-size N]`
 *
 * Direction: Reseller -> WeAreDA (contract 6.5).
 *
 * Catalog PUSH mode. The products sent are exactly the objects `GET /products`
 * would return - the same ProductService.serialize() feeds both transports.
 *
 * Two rules worth internalising:
 *
 *   1. A push is PARTIAL by nature. It says "here is what changed", never "here
 *      is everything I have". WeAreDA therefore never archives a product just
 *      because it was missing from your batch. To retire one, send it with
 *      status "archived" (`--status archived`).
 *
 *   2. Batches are capped at 500 products and 512 KB per event. Page a bigger
 *      catalog exactly as you would page GET /products - this command does that
 *      automatically and sends one event per page, each with its own event id.
 */
import type { CliContext, ParsedArgs } from '../context.js';
import { buildProductUpdatedEvent } from '../../weareda/events.js';
import { PRODUCT_BATCH_MAX_ITEMS, type Product } from '../../weareda/types.js';
import { log } from '../../lib/logger.js';

export async function productUpdateCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const wantsAll = args.flags.all === true;
  const ids = args.positionals;

  if (!wantsAll && ids.length === 0) {
    log.plain('Usage: npm run cli -- product-update <productId> [productId ...]');
    log.plain('       npm run cli -- product-update --all');
    log.plain('       npm run cli -- product-update P-1004 --status archived');
    return 1;
  }

  let products: Product[];
  if (wantsAll) {
    products = ctx.products.all();
  } else {
    products = [];
    for (const id of ids) {
      const product = ctx.products.find(id);
      if (!product) {
        log.plain(`Unknown product id: ${id}`);
        return 1;
      }
      products.push(product);
    }
  }

  const statusOverride = args.flags.status;
  if (typeof statusOverride === 'string') {
    products = products.map((product) => ({ ...product, status: statusOverride }));
    if (statusOverride === 'archived') {
      log.plain('');
      log.plain('Sending status "archived" - this is how a product is RETIRED in push mode.');
      log.plain('Omitting a product from a batch does NOT retire it (contract 6.5).');
    }
  }

  const pageSize = Math.min(
    PRODUCT_BATCH_MAX_ITEMS,
    Math.max(1, Number.parseInt(String(args.flags['page-size'] ?? PRODUCT_BATCH_MAX_ITEMS), 10)),
  );

  const pages: Product[][] = [];
  for (let index = 0; index < products.length; index += pageSize) {
    pages.push(products.slice(index, index + pageSize));
  }

  log.plain('');
  log.plain(
    `Pushing ${products.length} product(s) in ${pages.length} event(s) (cap ${PRODUCT_BATCH_MAX_ITEMS}/event).`,
  );
  log.plain('A push never implies a full catalog snapshot: absent products are NOT archived.');

  let failures = 0;
  for (const page of pages) {
    const event = buildProductUpdatedEvent(page);
    const result = await ctx.webhook.send(event, { dryRun: args.flags['dry-run'] === true });
    if (!result.dryRun && !result.ok) failures += 1;
  }

  return failures === 0 ? 0 : 1;
}
