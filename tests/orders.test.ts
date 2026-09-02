/**
 * POST /orders - contract 4.3.
 * Direction: WeAreDA -> Reseller.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestSandbox,
  customerPayload,
  orderPayload,
  orderPayloadWithoutCustomer,
  type TestSandbox,
} from './helpers.js';

describe('POST /orders (WeAreDA -> Reseller)', () => {
  let sandbox: TestSandbox;

  beforeEach(() => {
    sandbox = createTestSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function postOrder(payload: unknown, idempotencyKey?: string) {
    const response = await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      payload: payload as object,
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('accepts a contract-shaped order with 201', async () => {
    const { statusCode, body } = await postOrder(orderPayload(), 'order:6b1e');
    expect(statusCode).toBe(201);
    expect(body.status).toBe('received');
  });

  it('always returns an order id WeAreDA can store as external_order_id', async () => {
    const { body } = await postOrder(orderPayload(), 'order:6b1e');
    // Contract 4.3: WeAreDA reads `id`, `order_id` or `external_order_id`.
    expect(body.id).toMatch(/^SO-\d+$/);
  });

  it('generates sequential reseller order ids starting at SO-10001', async () => {
    const first = await postOrder(orderPayload({ idempotency_key: 'order:a' }), 'order:a');
    const second = await postOrder(orderPayload({ idempotency_key: 'order:b' }), 'order:b');
    expect(first.body.id).toBe('SO-10001');
    expect(second.body.id).toBe('SO-10002');
  });

  it('stores the delivered payload verbatim', async () => {
    const payload = orderPayload();
    const { body } = await postOrder(payload, 'order:6b1e');
    const stored = sandbox.orders.findById(body.id);
    expect(stored?.payload).toEqual(payload);
    expect(stored?.order_number).toBe('ORD-1042');
  });

  describe('idempotency (contract 4.3, 5)', () => {
    it('does not create a duplicate order for a repeated Idempotency-Key', async () => {
      const first = await postOrder(orderPayload(), 'order:6b1e');
      const second = await postOrder(orderPayload(), 'order:6b1e');

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(sandbox.orders.count()).toBe(1);
    });

    it('falls back to the body idempotency_key when the header is absent', async () => {
      const first = await postOrder(orderPayload());
      const second = await postOrder(orderPayload());
      expect(second.body.id).toBe(first.body.id);
      expect(sandbox.orders.count()).toBe(1);
    });

    it('treats different keys as different orders', async () => {
      await postOrder(orderPayload({ idempotency_key: 'order:one' }), 'order:one');
      await postOrder(orderPayload({ idempotency_key: 'order:two' }), 'order:two');
      expect(sandbox.orders.count()).toBe(2);
    });

    it('returns the same id even when the repeated body differs', async () => {
      // WeAreDA retries the same operation; the key is the identity, not the body.
      const first = await postOrder(orderPayload(), 'order:6b1e');
      const second = await postOrder(orderPayload({ notes: 'changed' }), 'order:6b1e');
      expect(second.body.id).toBe(first.body.id);
      expect(sandbox.orders.count()).toBe(1);
    });

    it('records the duplicate in the local history as a duplicate', async () => {
      await postOrder(orderPayload(), 'order:6b1e');
      await postOrder(orderPayload(), 'order:6b1e');
      const inbound = sandbox.eventLog.inbound(10);
      const notes = inbound.map((entry) => entry.note ?? '').join('\n');
      expect(notes).toContain('Duplicate delivery detected');
      expect(notes).toContain('No duplicate order created');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* The customer object and its fiscal identification (contract 4.3)        */
  /* ---------------------------------------------------------------------- */

  describe('customer and fiscal identification (contract 4.3)', () => {
    it('accepts an order with a full customer.tax_id and persists the customer', async () => {
      const payload = orderPayload();
      const { statusCode, body } = await postOrder(payload, 'order:6b1e');
      expect(statusCode).toBe(201);

      const stored = sandbox.orders.findById(body.id);
      // Stored verbatim, snapshot and all (contract 4.3.1).
      expect(stored?.payload.customer).toEqual(payload.customer);
      expect(stored?.payload.customer?.tax_id).toEqual({
        type: 'CUIT',
        value: '20-12345678-9',
        country: 'AR',
      });
      // ...and surfaced as columns for the invoice flow.
      expect(stored?.customer_name).toBe('Ada Lovelace');
      expect(stored?.customer_tax_id).toBe('20-12345678-9');
    });

    it('accepts an order with NO customer key, exactly as before the field existed', async () => {
      const payload = orderPayloadWithoutCustomer();
      expect(payload.customer).toBeUndefined();

      const { statusCode, body } = await postOrder(payload, 'order:no-customer');
      // The additive change must not have made anything required (contract 9).
      expect(statusCode).toBe(201);
      expect(body.status).toBe('received');

      const stored = sandbox.orders.findById(body.id);
      expect(stored?.payload.customer).toBeUndefined();
      expect(stored?.customer_name).toBeNull();
      expect(stored?.customer_tax_id).toBeNull();
    });

    it('accepts customer.tax_id: null - a contact with no fiscal identification', async () => {
      const { statusCode, body } = await postOrder(
        orderPayload({ customer: customerPayload({ tax_id: null }) }),
        'order:no-tax-id',
      );
      expect(statusCode).toBe(201);

      const stored = sandbox.orders.findById(body.id);
      // The key is present and null - branching on it needs no optional chaining.
      expect(stored?.payload.customer?.tax_id).toBeNull();
      expect(stored?.customer_tax_id).toBeNull();
      expect(stored?.customer_name).toBe('Ada Lovelace');
    });

    it('accepts a customer object with no tax_id key at all', async () => {
      const customer = customerPayload();
      delete customer.tax_id;
      const { statusCode, body } = await postOrder(
        orderPayload({ customer }),
        'order:missing-tax-id',
      );
      expect(statusCode).toBe(201);
      expect(sandbox.orders.findById(body.id)?.customer_tax_id).toBeNull();
    });

    /**
     * THE REGRESSION TEST FOR THE WHOLE FEATURE.
     *
     * `tax_id.type` is a free short token, not an enum. If someone ever adds a
     * list of "known" types and validates against it, this fails. KENNITALA is
     * Iceland's; the next one will be from a country nobody thought about.
     */
    it('accepts an UNKNOWN tax_id.type verbatim and never normalises it', async () => {
      const kennitala = { type: 'KENNITALA', value: '120174-3389', country: 'IS' };
      const { statusCode, body } = await postOrder(
        orderPayload({ customer: customerPayload({ tax_id: kennitala }) }),
        'order:kennitala',
      );

      expect(statusCode).toBe(201);
      const stored = sandbox.orders.findById(body.id);
      expect(stored?.payload.customer?.tax_id).toEqual(kennitala);
      // Not mapped, not renamed, not coerced into a type we do recognise.
      expect(stored?.payload.customer?.tax_id?.type).toBe('KENNITALA');
      expect(stored?.customer_tax_id).toBe('120174-3389');
    });

    it('accepts a tax_id value in a format nothing here recognises', async () => {
      const { statusCode } = await postOrder(
        orderPayload({
          customer: customerPayload({ tax_id: { type: 'TAX_ID', value: 'no-checksum-at-all' } }),
        }),
        'order:weird-format',
      );
      expect(statusCode).toBe(201);
    });

    it('accepts an order whose customer has no name', async () => {
      const customer = customerPayload();
      delete customer.name;
      const { statusCode, body } = await postOrder(orderPayload({ customer }), 'order:no-name');
      expect(statusCode).toBe(201);
      expect(sandbox.orders.findById(body.id)?.customer_name).toBeNull();
    });

    it('stays idempotent when the same order is re-delivered with the same customer', async () => {
      const first = await postOrder(orderPayload(), 'order:6b1e');
      const second = await postOrder(orderPayload(), 'order:6b1e');

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(sandbox.orders.count()).toBe(1);
      expect(sandbox.orders.findById(first.body.id)?.customer_tax_id).toBe('20-12345678-9');
    });

    describe('a malformed customer is handled, never with a 500', () => {
      for (const [label, customer] of [
        ['a string', 'Ada Lovelace'],
        ['an array', [{ name: 'Ada' }]],
        ['a number', 42],
      ] as const) {
        it(`rejects ${label} with 400, not 500`, async () => {
          const { statusCode, body } = await postOrder(
            orderPayload({ customer }),
            `order:bad-${label.replace(/\s/g, '-')}`,
          );
          expect(statusCode).toBe(400);
          expect(body.error).toBe('invalid_order');
          expect(body.details.join(' ')).toContain('customer must be an object');
        });
      }

      it('does not reject a malformed tax_id - it is treated as no fiscal id', async () => {
        // A shape we cannot read is not a reason to send the order to
        // manual_review. Accept it, store it verbatim, invoice without it.
        const { statusCode, body } = await postOrder(
          orderPayload({ customer: customerPayload({ tax_id: 'CUIT 20-12345678-9' }) }),
          'order:bad-tax-id',
        );
        expect(statusCode).toBe(201);
        expect(sandbox.orders.findById(body.id)?.customer_tax_id).toBeNull();
      });

      it('accepts customer: null as no customer at all', async () => {
        const { statusCode } = await postOrder(
          orderPayload({ customer: null }),
          'order:null-customer',
        );
        expect(statusCode).toBe(201);
      });
    });

    it('derives no stock, status or other behaviour from the customer', async () => {
      // Contract 6.4 is unchanged by any of this: the customer object is data.
      const before = sandbox.products.stockSnapshot();
      const { body } = await postOrder(orderPayload(), 'order:6b1e');
      const after = sandbox.products.stockSnapshot();

      expect(after).toEqual(before);
      expect(sandbox.orders.findById(body.id)?.status).toBe('received');
    });
  });

  describe('validation', () => {
    it('rejects an order with no items', async () => {
      const { statusCode, body } = await postOrder(orderPayload({ items: [] }), 'order:x');
      expect(statusCode).toBe(400);
      expect(body.error).toBe('invalid_order');
      expect(body.details).toContain('items must be a non-empty array');
    });

    it('rejects an item with no product reference', async () => {
      const { statusCode, body } = await postOrder(
        orderPayload({ items: [{ quantity: 1, name: 'Mystery' }] }),
        'order:x',
      );
      expect(statusCode).toBe(400);
      expect(body.details.join(' ')).toContain('external_product_id');
    });

    it('rejects a non-positive quantity', async () => {
      const { statusCode, body } = await postOrder(
        orderPayload({ items: [{ external_product_id: 'P-1001', quantity: 0 }] }),
        'order:x',
      );
      expect(statusCode).toBe(400);
      expect(body.details.join(' ')).toContain('quantity');
    });

    it('rejects an order that carries no identity at all', async () => {
      const { statusCode, body } = await postOrder({
        items: [{ external_product_id: 'P-1001', quantity: 1 }],
      });
      expect(statusCode).toBe(400);
      expect(body.details.join(' ')).toContain('order_number or idempotency_key');
    });

    it('rejects a malformed JSON body with 400, not 401 or 500', async () => {
      const response = await sandbox.app.inject({
        method: 'POST',
        url: '/orders',
        headers: authHeaders({ 'content-type': 'application/json' }),
        payload: '{"order_number": "ORD-1", ',
      });
      expect(response.statusCode).toBe(400);
    });

    it('creates no order when validation fails', async () => {
      await postOrder(orderPayload({ items: [] }), 'order:x');
      expect(sandbox.orders.count()).toBe(0);
    });
  });
});
