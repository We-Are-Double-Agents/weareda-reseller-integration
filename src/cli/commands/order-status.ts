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
 * State mapping (contract 6.1) - TWO columns:
 *
 *   state                                   integration_status  orders.status
 *   ---------------------------------------------------------------------------
 *   accepted | acknowledged | ack           accepted            confirmed
 *   shipped | fulfilled                     completed           shipped
 *   delivered | completed                   completed           delivered
 *   cancelled | canceled                    cancelled           cancelled
 *   returned | return | refunded |
 *     not_delivered | undelivered           returned            refunded
 *   rejected | failed | error               manual_review       (unchanged)
 *   anything else                           NOT MAPPED          (unchanged)
 *
 * The second column only moves when the tenant registered
 * `orderStatusWrite: true` at connect time. This command prints what WOULD
 * happen for the setting in your .env (ORDER_STATUS_WRITE), including the
 * ladder rule that discards a lower rung arriving after a higher one.
 *
 * An unmapped state is deliberately allowed here so you can watch what WeAreDA
 * does with it: the operation is rejected with `unknown_order_state` and the
 * order is left exactly as it was.
 *
 * order.status NEVER changes stock - not even `shipped` or `delivered`.
 */
import type { CliContext, ParsedArgs } from '../context.js';
import { buildOrderStatusEvent } from '../../weareda/events.js';
import {
  MAPPED_ORDER_STATES,
  mapsToIntegrationStatus,
  resolveOrderStatusTransition,
} from '../../weareda/types.js';
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
      : `state "${state}" is NOT MAPPED - the operation is rejected with ` +
          'unknown_order_state and the order is left exactly as it was',
  );

  // What the CUSTOMER-FACING status would do. `--current` lets you try the
  // ladder and the exceptions without a real order behind it.
  const orderStatusWrite = ctx.config.integration.orderStatusWrite;
  const currentStatus = typeof args.flags.current === 'string' ? args.flags.current : 'confirmed';
  const transition = resolveOrderStatusTransition({ currentStatus, state, orderStatusWrite });

  log.plain('');
  log.plain(`orderStatusWrite = ${orderStatusWrite} (ORDER_STATUS_WRITE in .env)`);
  log.plain(`Assuming orders.status is currently "${currentStatus}" (override with --current):`);
  log.plain(`  result.detail   ${transition.detail}`);
  if (transition.errorCode) {
    log.plain(`  last_error_code ${transition.errorCode}`);
  }
  if (!orderStatusWrite) {
    log.plain('  Enable it at connect time: integration:connect --order-status-write');
  }

  log.plain('');
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
