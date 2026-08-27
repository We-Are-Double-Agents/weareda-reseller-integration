/**
 * `npm run scenario:order-status`
 *
 * What an inbound order.status event does to the TWO status columns
 * (contract 6.1), including the rules that are not obvious:
 *
 *   LADDER      draft -> pending -> confirmed -> processing -> shipped -> delivered
 *               Only ever ADVANCES. A lower rung arriving after a higher one is
 *               a late or reordered event and is IGNORED, not applied.
 *
 *   EXCEPTIONS  cancelled, refunded
 *               Apply from ANY rung at ANY time - including after
 *               shipped/delivered. An order the customer refused on delivery is
 *               an ordinary outcome.
 *
 * The customer-facing column only moves when the tenant registered
 * `orderStatusWrite: true` at connect time. Both settings are shown below.
 */
import { createScenarioContext, scenarioBanner, step, webhookModeNotice } from './harness.js';
import { buildOrderStatusEvent } from '../weareda/events.js';
import {
  mapsToIntegrationStatus,
  mapsToOrderStatus,
  resolveOrderStatusTransition,
} from '../weareda/types.js';
import { log } from '../lib/logger.js';

/** Replays a sequence of reseller states through the transition rules. */
function replay(title: string, start: string, states: string[], orderStatusWrite: boolean): void {
  log.plain('');
  log.plain(`${title}   (orderStatusWrite: ${orderStatusWrite})`);
  log.plain(`  orders.status starts at "${start}"`);
  let current = start;
  for (const state of states) {
    const transition = resolveOrderStatusTransition({
      currentStatus: current,
      state,
      orderStatusWrite,
    });
    if (transition.outcome === 'applied' && transition.orderStatus) {
      current = transition.orderStatus;
    }
    log.plain(
      `  state "${state}"`.padEnd(32) +
        `integration_status: ${String(transition.integrationStatus ?? '(unchanged)').padEnd(14)}` +
        `${transition.detail}` +
        (transition.errorCode ? `  [last_error_code: ${transition.errorCode}]` : ''),
    );
  }
  log.plain(`  orders.status ends at "${current}"`);
}

async function main(): Promise<void> {
  const ctx = await createScenarioContext();

  scenarioBanner('SCENARIO: order.status, both status columns', [
    'orderStatusWrite is a TOP-LEVEL connect field, a sibling of',
    'orderDeliveryStatus. Strict boolean, default false.',
    '',
    `This sandbox is configured with orderStatusWrite = ${ctx.config.integration.orderStatusWrite}`,
    '(ORDER_STATUS_WRITE in .env).',
  ]);
  webhookModeNotice(ctx);

  /* -------------------------------------------------------------------- */
  step(1, 'The mapping table has TWO columns');
  log.plain('state                                     integration_status   orders.status');
  log.plain('-'.repeat(78));
  for (const state of [
    'accepted',
    'acknowledged',
    'ack',
    'shipped',
    'fulfilled',
    'delivered',
    'completed',
    'cancelled',
    'canceled',
    'returned',
    'refunded',
    'not_delivered',
    'rejected',
    'failed',
    'packed_in_warehouse',
  ]) {
    const integration = mapsToIntegrationStatus(state);
    const order = mapsToOrderStatus(state);
    log.plain(
      `${state.padEnd(42)}${(integration ?? 'NOT MAPPED').padEnd(21)}${order ?? '(unchanged)'}`,
    );
  }
  log.plain('');
  log.plain('`shipped` and `delivered` both COLLAPSE to integration_status "completed",');
  log.plain('so the customer-facing status is derived from the RAW state, never from');
  log.plain('integration_status. And `fulfilled` maps to shipped, not delivered:');
  log.plain('the cheaper wrong guess, because the ladder would discard the real');
  log.plain('`delivered` event afterwards if we had guessed the top rung.');
  log.plain('');
  log.plain('A return is NOT a cancellation. `cancelled` = never shipped; `returned` =');
  log.plain('shipped and came back. A return triggers no cancellation call back to us.');

  /* -------------------------------------------------------------------- */
  step(2, 'The happy sequence, with the opt-in OFF (the default)');
  replay(
    'accepted -> shipped -> delivered',
    'confirmed',
    ['accepted', 'shipped', 'delivered'],
    false,
  );
  log.plain('');
  log.plain('integration_status moves on every event; orders.status never does.');

  /* -------------------------------------------------------------------- */
  step(3, 'The same sequence, with the opt-in ON');
  replay(
    'accepted -> shipped -> delivered',
    'confirmed',
    ['accepted', 'shipped', 'delivered'],
    true,
  );
  log.plain('');
  log.plain('Each move fires the same downstream effects a manual status change in the');
  log.plain('CRM fires: alert notifications and conversation-lifecycle automation.');
  log.plain('shipped_at / delivered_at are filled in when blank, never overwritten.');

  /* -------------------------------------------------------------------- */
  step(4, 'An exception applying AFTER shipping');
  replay('shipped -> refunded', 'confirmed', ['shipped', 'returned'], true);
  log.plain('');
  log.plain('cancelled and refunded ignore the ladder. A customer who refuses the');
  log.plain('parcel on delivery is an ordinary outcome, not an anomaly.');

  /* -------------------------------------------------------------------- */
  step(5, 'A late event, discarded by the ladder');
  replay(
    'delivered, then a late "accepted"',
    'confirmed',
    ['shipped', 'delivered', 'accepted'],
    true,
  );
  log.plain('');
  log.plain('The ladder only advances, so a lower rung arriving late changes nothing.');

  /* -------------------------------------------------------------------- */
  step(6, 'A contradiction between the two systems');
  replay('cancelled, then a fulfilment step', 'confirmed', ['cancelled', 'shipped'], true);
  log.plain('');
  log.plain('The order is left UNTOUCHED, its integration_status becomes manual_review,');
  log.plain('and the operation is rejected with order_status_conflict. Neither side');
  log.plain('wins automatically - a human decides.');

  /* -------------------------------------------------------------------- */
  step(7, 'Sending the sequence for real');
  const order = ctx.orders.list(1)[0];
  const reference = order?.id ?? 'SO-10001';
  log.plain(`Using order ${reference}. Each transition is its own request with its own`);
  log.plain('event id - reusing an id dedups silently and applies nothing.');
  for (const state of ['accepted', 'shipped', 'delivered']) {
    await ctx.webhook.send(buildOrderStatusEvent({ externalOrderId: reference, state }));
  }

  scenarioBanner('SCENARIO COMPLETE', [
    'integration_status always moves. orders.status moves only with',
    'orderStatusWrite: true, and only along the ladder - except for',
    'cancelled and refunded, which apply from anywhere.',
    '',
    'Why the two settings are independent:',
    '  integrationMode  is stored per RESELLER and describes topology.',
    '  orderStatusWrite is stored per TENANT and is a question of data',
    '                   authority - may an external event rewrite a column',
    "                   the tenant's staff see and edit?",
    '',
    'Choosing receive_and_send does NOT imply orderStatusWrite.',
  ]);

  await ctx.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
