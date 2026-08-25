/**
 * `cli order-status <orderId|orderNumber> <state>`
 *
 * Direction: Reseller -> WeAreDA (contract 6.1).
 *
 * Send ONE event per transition, each with its own event id:
 *
 *   npm run cli -- order-status SO-10001 accepted
 *   npm run cli -- order-status SO-10001 shipped
 *   npm run cli -- order-status SO-10001 delivered
 *
 * State mapping (contract 6.1):
 *   accepted | acknowledged | ack               -> accepted
 *   fulfilled | completed | shipped | delivered -> completed
 *   cancelled | canceled                        -> cancelled
 *   rejected | failed | error                   -> manual_review
 *   anything else                               -> NOT MAPPED
 *
 * An unmapped state is deliberately allowed here so you can watch what WeAreDA
 * does with it: the event is parked for a human and the order's
 * integration_status is left exactly as it was.
 *
 * order.status NEVER changes stock - not even `shipped` or `delivered`.
 */
import type { CliContext, ParsedArgs } from '../context.js';
import { buildOrderStatusEvent } from '../../weareda/events.js';
import { MAPPED_ORDER_STATES, mapsToIntegrationStatus } from '../../weareda/types.js';
import { log } from '../../lib/logger.js';

export async function orderStatusCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const [reference, state] = args.positionals;

  if (!reference || !state) {
    log.plain('Usage: npm run cli -- order-status <orderId|orderNumber> <state>');
    log.plain('');
    log.plain(`Mapped states: ${MAPPED_ORDER_STATES.join(', ')}`);
    log.plain('Any other value is sent as-is so you can observe the "not mapped" behaviour.');
    return 1;
  }

  const known = ctx.orders.findById(reference) ?? ctx.orders.findByOrderNumber(reference);
  const mapped = mapsToIntegrationStatus(state);

  log.plain('');
  if (known) {
    log.plain(
      `Local order ${known.id} (order_number ${known.order_number ?? 'n/a'}), status ${known.status}`,
    );
  } else {
    log.plain(
      `No local order matches "${reference}". Sending anyway - useful for testing how WeAreDA ` +
        'handles an unresolvable reference (contract 6.1: the order is left untouched).',
    );
  }

  log.plain(
    mapped
      ? `state "${state}" maps to integration_status "${mapped}"`
      : `state "${state}" is NOT MAPPED - WeAreDA parks the event and leaves integration_status unchanged`,
  );
  log.plain('Reminder: this event does not change stock (contract 6.1).');

  // Prefer external_order_id (the id WeAreDA stored from our POST /orders
  // response); fall back to order_number.
  const event = buildOrderStatusEvent({
    externalOrderId: known?.id ?? (reference.startsWith('SO-') ? reference : undefined),
    orderNumber: known?.order_number ?? (reference.startsWith('SO-') ? undefined : reference),
    state,
    eventId: typeof args.flags['event-id'] === 'string' ? args.flags['event-id'] : undefined,
  });

  const result = await ctx.webhook.send(event, { dryRun: args.flags['dry-run'] === true });
  return result.dryRun || result.ok ? 0 : 1;
}
