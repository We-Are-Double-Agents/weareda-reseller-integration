/**
 * POST /orders - contract 4.3.
 * Direction: WeAreDA -> Reseller.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestSandbox, orderPayload, type TestSandbox } from './helpers.js';

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
