/**
 * `cli stock <id> <quantity> [<id> <quantity> ...]`
 *
 * Direction: Reseller -> WeAreDA (contract 6.2).
 *
 * ============================================================================
 * THIS is where stock changes. Never in the order routes.
 * ============================================================================
 * The command does two DISTINCT things, in this order:
 *
 *   1. Simulates YOUR ERP recalculating inventory (writes the new absolute
 *      on-hand quantity into local storage). In a real integration this is your
 *      warehouse system, not us.
 *   2. Reports the result to WeAreDA as ONE batched stock.updated event.
 *
 * `quantity` is ABSOLUTE:
 *      stock P-1001 37     means "P-1001 now has 37 on hand"
 *      stock P-1001 37     does NOT mean "add 37 to P-1001"
 *      stock P-1003 0      is valid and means sold out
 */
import type { CliContext, ParsedArgs } from '../context.js';
import { buildStockUpdatedEvent } from '../../weareda/events.js';
import type { StockItem } from '../../weareda/types.js';
import { log } from '../../lib/logger.js';

export async function stockCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const pairs = args.positionals;
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    log.plain(
      'Usage: npm run cli -- stock <productOrVariantId> <absoluteQuantity> [<id> <qty> ...]',
    );
    log.plain('');
    log.plain('Example - one event carrying two lines (batching is the intended usage):');
    log.plain('  npm run cli -- stock P-1001 37 V-2001 5');
    return 1;
  }

  const items: StockItem[] = [];

  log.plain('');
  log.plain('STEP 1 - simulate the reseller ERP recalculating inventory');
  log.plain("(this is your system's own business; WeAreDA never does this for you)");
  log.plain('');

  for (let index = 0; index < pairs.length; index += 2) {
    const entityId = pairs[index] as string;
    const quantity = Number.parseInt(pairs[index + 1] as string, 10);

    const { entityType, previous } = ctx.products.setStock(entityId, quantity);

    log.plain(
      `  ${entityType.padEnd(7)} ${entityId.padEnd(10)} ${String(previous).padStart(5)} -> ${String(quantity).padStart(5)}  (absolute on-hand)`,
    );

    items.push(
      entityType === 'variant'
        ? { external_variant_id: entityId, quantity }
        : { external_product_id: entityId, quantity },
    );
  }

  log.plain('');
  log.plain('STEP 2 - report the new absolute quantities to WeAreDA');
  log.plain(`(ONE stock.updated event carrying all ${items.length} affected line(s))`);

  const event = buildStockUpdatedEvent(items, flagString(args, 'event-id'));
  const result = await ctx.webhook.send(event, { dryRun: args.flags['dry-run'] === true });

  return result.dryRun || result.ok ? 0 : 1;
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}
