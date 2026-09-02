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
 *
 * The order also carries a `customer` with a fiscal identification (contract
 * 4.3). Watch where it appears: in full in the stored order (you invoice
 * against it), and MASKED everywhere it is rendered - the request log, the
 * event history and this scenario's own output (contract 11.8).
 */
import { createScenarioContext, scenarioBanner, step, webhookModeNotice } from './harness.js';
import { buildOrderStatusEvent, buildStockUpdatedEvent } from '../weareda/events.js';
import { log } from '../lib/logger.js';
import { maskTaxId, maskTaxIds } from '../lib/redact.js';
import { taxIdOf, type OrderPayload } from '../weareda/types.js';

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
  // Contract 4.3. Omitted entirely when the order has no contact; `tax_id` is
  // null when the contact has no fiscal identification (see the cancellation
  // scenario for that path). The number below is deliberately fake.
  customer: {
    id: 'contact-0000-example',
    name: 'Example Customer',
    first_name: 'Example',
    last_name: 'Customer',
    email: 'customer@example.test',
    phone: '+541100000000',
    // `type` is a free token, NOT an enum. Accept whatever arrives.
    tax_id: { type: 'CUIT', value: '20-12345678-9', country: 'AR' },
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
  const delivered = taxIdOf(DEMO_ORDER);
  log.plain(
    `The order carries a customer with a fiscal id: ${delivered?.type} ` +
      `${maskTaxId(delivered?.value)} (${delivered?.country}) - masked here and in the log.`,
  );

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
  // Printed masked. The row itself keeps the real value - that is what the
  // invoice flow reads (contract 4.3, 11.8).
  log.plain(JSON.stringify(maskTaxIds(stored), null, 2));
  log.plain('');
  log.plain(
    'customer_name / customer_tax_id are surfaced as columns for the invoice flow. ' +
      'Nothing about the customer changes how the order is handled: it does not ' +
      'gate acceptance, it does not touch stock, and an unknown tax_id.type is ' +
      'stored verbatim (contract 4.3).',
  );
  log.plain('Try the payoff:  npm run cli -- invoice ' + orderId);

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
    'The customer travelled with the order and its fiscal id was masked in every',
    'log line (contract 11.8). An order WITHOUT one is equally valid - see',
    '`npm run scenario:cancellation`, whose order has customer.tax_id: null.',
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
