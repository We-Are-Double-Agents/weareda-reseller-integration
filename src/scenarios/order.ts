/**
 * `npm run scenario:order`
 *
 * The complete happy path of contract 6.4, step by step:
 *
 *   1. WeAreDA delivers an order        (POST /orders)
 *   2. The reseller stores it and returns its own id
 *   3. NOTHING happens to stock
 *   4. The ERP recalculates inventory   (explicit, separate)
 *   5. stock.updated reports absolute quantities
 *   6. order.status accepted
 *   7. order.status shipped
 *   8. order.status delivered
 *
 * Steps 5 and 6-8 are different HTTP requests with different event ids, and
 * neither implies the other.
 */
import { createScenarioContext, scenarioBanner, step, webhookModeNotice } from './harness.js';
import { buildOrderStatusEvent, buildStockUpdatedEvent } from '../weareda/events.js';
import { log } from '../lib/logger.js';
import type { OrderPayload } from '../weareda/types.js';

const DEMO_ORDER: OrderPayload = {
  order_number: `ORD-${Math.floor(Date.now() / 1000) % 100000}`,
  currency: 'USD',
  subtotal: 17998,
  discount: 0,
  tax: 0,
  shipping: 500,
  total: 18498,
  notes: 'Scenario demo order - no real customer data.',
  shipping_address: {
    name: 'Example Recipient',
    line1: '1 Example Street',
    city: 'Example City',
    country: 'AR',
  },
  idempotency_key: `order:scenario-${Date.now()}`,
  items: [
    {
      sku: 'WIDGET-PRO-S',
      external_product_id: 'P-1002',
      external_variant_id: 'V-2001',
      name: 'Widget Pro',
      variant_name: 'Small / Black',
      quantity: 2,
      unit_price: 8999,
      discount: 0,
      subtotal: 17998,
    },
  ],
};

async function main(): Promise<void> {
  const ctx = await createScenarioContext();

  scenarioBanner('SCENARIO: order delivery -> fulfilment', [
    'Direction legend:',
    '  WeAreDA -> Reseller : inbound HTTP to this sandbox',
    '  Reseller -> WeAreDA : signed webhook events',
    '',
    `Sandbox: ${ctx.baseUrl}`,
  ]);
  webhookModeNotice(ctx);

  /* -------------------------------------------------------------------- */
  step(1, 'WeAreDA -> Reseller: POST /orders');
  const before = ctx.products.stockSnapshot();
  log.plain(`Stock before: P-1002=${before['P-1002']} V-2001=${before['V-2001']}`);

  const delivery = await ctx.callAsWeAreDA('POST', '/orders', {
    body: DEMO_ORDER,
    idempotencyKey: DEMO_ORDER.idempotency_key,
  });
  log.plain(`Response: ${delivery.status} ${JSON.stringify(delivery.body)}`);

  const orderId: string = delivery.body?.id;
  if (!orderId) throw new Error('The sandbox did not return an order id - see contract 4.3.');

  /* -------------------------------------------------------------------- */
  step(2, 'The order now exists on the reseller side');
  const stored = ctx.orders.findById(orderId);
  log.plain(JSON.stringify(stored, null, 2));

  /* -------------------------------------------------------------------- */
  step(3, 'Stock was NOT touched by the delivery');
  const after = ctx.products.stockSnapshot();
  log.plain(`Stock after:  P-1002=${after['P-1002']} V-2001=${after['V-2001']}`);
  log.plain(
    before['P-1002'] === after['P-1002'] && before['V-2001'] === after['V-2001']
      ? 'Unchanged, as the contract requires (6.4). WeAreDA did not reserve or decrement anything either.'
      : 'UNEXPECTED: stock moved on order delivery. That would violate contract 6.4.',
  );

  /* -------------------------------------------------------------------- */
  step(4, 'Reseller ERP recalculates inventory (explicit, and entirely ours)');
  const orderedProduct = 2;
  const newVariantQty = Math.max(0, (after['V-2001'] ?? 0) - orderedProduct);
  const newProductQty = Math.max(0, (after['P-1002'] ?? 0) - orderedProduct);
  log.plain('This is the step WeAreDA never performs for you.');
  log.plain(`V-2001: ${after['V-2001']} -> ${newVariantQty} (absolute)`);
  log.plain(`P-1002: ${after['P-1002']} -> ${newProductQty} (absolute)`);
  ctx.products.setStock('V-2001', newVariantQty);
  ctx.products.setStock('P-1002', newProductQty);

  /* -------------------------------------------------------------------- */
  step(5, 'Reseller -> WeAreDA: stock.updated (its own request, its own event id)');
  await ctx.webhook.send(
    buildStockUpdatedEvent([
      { external_product_id: 'P-1002', quantity: newProductQty },
      { external_variant_id: 'V-2001', quantity: newVariantQty },
    ]),
  );

  /* -------------------------------------------------------------------- */
  for (const [index, state] of [
    [6, 'accepted'],
    [7, 'shipped'],
    [8, 'delivered'],
  ] as const) {
    step(index, `Reseller -> WeAreDA: order.status "${state}"`);
    log.plain('A separate HTTP request with its own event id. Changes no stock.');
    await ctx.webhook.send(
      buildOrderStatusEvent({
        externalOrderId: orderId,
        orderNumber: DEMO_ORDER.order_number,
        state,
      }),
    );
  }

  scenarioBanner('SCENARIO COMPLETE', [
    `Order ${orderId} was delivered, accepted, shipped and delivered.`,
    'Stock moved exactly once - in step 4-5, because the ERP said so,',
    'never because an order event implied it.',
    '',
    'Inspect what happened:',
    `  curl ${ctx.baseUrl}/debug/orders`,
    `  curl ${ctx.baseUrl}/debug/events`,
  ]);

  await ctx.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
