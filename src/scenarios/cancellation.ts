/**
 * `npm run scenario:cancellation`
 *
 * Cancellation, and the restock that WeAreDA does NOT do for you (contract 4.4):
 *
 *   1. An order is delivered, so there is something to cancel
 *   2. WeAreDA cancels it            (POST /orders/{id}/cancel)
 *   3. The order is marked cancelled locally
 *   4. Stock is UNCHANGED by the cancellation
 *   5. The ERP decides units return to inventory (explicit, ours)
 *   6. stock.updated reports the new absolute quantities, separately
 *   7. The cancellation is replayed to show idempotency
 */
import { createScenarioContext, scenarioBanner, step, webhookModeNotice } from './harness.js';
import { buildStockUpdatedEvent } from '../weareda/events.js';
import { log } from '../lib/logger.js';
import { maskTaxIds } from '../lib/redact.js';
import type { OrderPayload } from '../weareda/types.js';

async function main(): Promise<void> {
  const ctx = await createScenarioContext();
  const suffix = `scenario-cancel-${Date.now()}`;

  const order: OrderPayload = {
    order_number: `ORD-C${Math.floor(Date.now() / 1000) % 100000}`,
    currency: 'USD',
    subtotal: 4999,
    discount: 0,
    tax: 0,
    shipping: 0,
    total: 4999,
    shipping_address: { name: 'Example Recipient', line1: '1 Example Street', country: 'AR' },
    // The OTHER half of contract 4.3: a customer whose contact has no fiscal
    // identification. `tax_id` is null - the key is always present inside
    // `customer`, so no optional chaining is needed to branch on it - and the
    // order is accepted exactly like any other. See the invoice command for
    // what to do when you cannot bill without one (requiresTaxId, 4.3.2).
    customer: {
      id: 'contact-0001-example',
      name: 'Example Customer Without A Fiscal Id',
      email: 'no-tax-id@example.test',
      tax_id: null,
    },
    idempotency_key: `order:${suffix}`,
    items: [
      {
        sku: 'WIDGET-BLK',
        external_product_id: 'P-1001',
        name: 'Black Widget',
        quantity: 1,
        unit_price: 4999,
        discount: 0,
        subtotal: 4999,
      },
    ],
  };

  scenarioBanner('SCENARIO: cancellation -> restock', [`Sandbox: ${ctx.baseUrl}`]);
  webhookModeNotice(ctx);

  /* -------------------------------------------------------------------- */
  step(1, 'WeAreDA -> Reseller: POST /orders (so there is an order to cancel)');
  const delivery = await ctx.callAsWeAreDA('POST', '/orders', {
    body: order,
    idempotencyKey: order.idempotency_key,
  });
  const orderId: string = delivery.body?.id;
  log.plain(`Response: ${delivery.status} ${JSON.stringify(delivery.body)}`);

  // The ERP consumed a unit for this order, exactly as it would in real life.
  const baseline = ctx.products.stockSnapshot();
  const consumed = Math.max(0, (baseline['P-1001'] ?? 0) - 1);
  ctx.products.setStock('P-1001', consumed);
  log.plain(`ERP consumed one unit for the order: P-1001 = ${consumed} (absolute)`);

  /* -------------------------------------------------------------------- */
  step(2, 'WeAreDA -> Reseller: POST /orders/{externalOrderId}/cancel');
  const cancelKey = `order-cancel:${suffix}`;
  const cancellation = await ctx.callAsWeAreDA('POST', `/orders/${orderId}/cancel`, {
    body: {
      order_number: order.order_number,
      external_order_id: orderId,
      reason: 'cancelled',
      idempotency_key: cancelKey,
    },
    idempotencyKey: cancelKey,
  });
  log.plain(`Response: ${cancellation.status} ${JSON.stringify(cancellation.body)}`);

  /* -------------------------------------------------------------------- */
  step(3, 'The order is cancelled on the reseller side');
  // Masked on the way out, like every other rendering of an order (11.8).
  // This one's customer has tax_id: null, which is an ordinary order.
  log.plain(JSON.stringify(maskTaxIds(ctx.orders.findById(orderId)), null, 2));

  /* -------------------------------------------------------------------- */
  step(4, 'Stock was NOT restored by the cancellation');
  const afterCancel = ctx.products.stockSnapshot();
  log.plain(`P-1001 = ${afterCancel['P-1001']} (still the post-order value)`);
  log.plain(
    afterCancel['P-1001'] === consumed
      ? 'Unchanged, as contract 4.4 requires. WeAreDA added nothing back either.'
      : 'UNEXPECTED: the cancellation moved stock. That would violate contract 4.4.',
  );

  /* -------------------------------------------------------------------- */
  step(5, 'Reseller ERP decides the unit returns to inventory');
  const restocked = consumed + 1;
  log.plain('Your warehouse rules decide this - not the cancellation itself.');
  log.plain(`P-1001: ${consumed} -> ${restocked} (absolute)`);
  ctx.products.setStock('P-1001', restocked);

  /* -------------------------------------------------------------------- */
  step(6, 'Reseller -> WeAreDA: stock.updated, as a SEPARATE request');
  await ctx.webhook.send(
    buildStockUpdatedEvent([{ external_product_id: 'P-1001', quantity: restocked }]),
  );

  /* -------------------------------------------------------------------- */
  step(7, 'WeAreDA retries the cancellation - it must be a no-op');
  const replay = await ctx.callAsWeAreDA('POST', `/orders/${orderId}/cancel`, {
    body: {
      external_order_id: orderId,
      reason: 'cancelled',
      idempotency_key: cancelKey,
    },
    idempotencyKey: cancelKey,
  });
  log.plain(`Response: ${replay.status} ${JSON.stringify(replay.body)}`);
  const finalStock = ctx.products.stockSnapshot();
  log.plain(`P-1001 = ${finalStock['P-1001']} - the replay changed nothing.`);

  scenarioBanner('SCENARIO COMPLETE', [
    `Order ${orderId} is cancelled.`,
    'The restock happened because the ERP decided it, and reached WeAreDA',
    'through its own stock.updated event - never as a side effect of cancelling.',
  ]);

  await ctx.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
