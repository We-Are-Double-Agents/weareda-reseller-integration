/**
 * ============================================================================
 * MANDATORY TESTS - contract 6.4
 * ============================================================================
 * "Orders and stock are two independent flows."
 *
 * WeAreDA never infers, reserves, decrements or restores reseller stock from an
 * order event, and a correct reseller implementation does not do it implicitly
 * either. These tests exist to make that impossible to regress.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestSandbox, orderPayload, type TestSandbox } from './helpers.js';

describe('orders and stock are independent flows (contract 6.4)', () => {
  let sandbox: TestSandbox;

  beforeEach(() => {
    sandbox = createTestSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function deliverOrder(idempotencyKey = 'order:6b1e') {
    const response = await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders({ 'idempotency-key': idempotencyKey }),
      payload: orderPayload({ idempotency_key: idempotencyKey }),
    });
    return response;
  }

  it('POST /orders does NOT change stock', async () => {
    const before = sandbox.products.stockSnapshot();

    const response = await deliverOrder();
    expect(response.statusCode).toBe(201);

    const after = sandbox.products.stockSnapshot();
    expect(after).toEqual(before);
  });

  it('POST /orders does not touch the ordered product or variant specifically', async () => {
    // The demo order takes quantity 2 of P-1002 / V-2001.
    const before = sandbox.products.stockSnapshot();
    expect(before['P-1002']).toBe(30);
    expect(before['V-2001']).toBe(12);

    await deliverOrder();

    const after = sandbox.products.stockSnapshot();
    expect(after['P-1002']).toBe(30);
    expect(after['V-2001']).toBe(12);
  });

  it('POST /orders/:id/cancel does NOT change stock', async () => {
    const orderId = (await deliverOrder()).json().id;
    const before = sandbox.products.stockSnapshot();

    const response = await sandbox.app.inject({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      headers: authHeaders({ 'idempotency-key': 'order-cancel:6b1e' }),
      payload: { external_order_id: orderId, reason: 'cancelled' },
    });
    expect(response.statusCode).toBe(200);

    const after = sandbox.products.stockSnapshot();
    expect(after).toEqual(before);
  });

  it('POST /orders/cancel (fallback) does NOT change stock either', async () => {
    await deliverOrder();
    const before = sandbox.products.stockSnapshot();

    await sandbox.app.inject({
      method: 'POST',
      url: '/orders/cancel',
      headers: authHeaders(),
      payload: { order_number: 'ORD-1042', reason: 'refunded' },
    });

    expect(sandbox.products.stockSnapshot()).toEqual(before);
  });

  it('a full order lifecycle leaves stock untouched from beginning to end', async () => {
    const before = sandbox.products.stockSnapshot();

    const orderId = (await deliverOrder()).json().id;
    await deliverOrder(); // retry of the same delivery
    await sandbox.app.inject({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      headers: authHeaders({ 'idempotency-key': 'order-cancel:6b1e' }),
      payload: { external_order_id: orderId },
    });
    await sandbox.app.inject({
      method: 'POST',
      url: `/orders/${orderId}/cancel`,
      headers: authHeaders({ 'idempotency-key': 'order-cancel:6b1e' }),
      payload: { external_order_id: orderId },
    });

    expect(sandbox.products.stockSnapshot()).toEqual(before);
  });

  it('GET /products reports the same stock before and after an order', async () => {
    const read = async () => {
      const response = await sandbox.app.inject({
        method: 'GET',
        url: '/products',
        headers: authHeaders(),
      });
      return response.json().products.map((p: { id: string; stock: number }) => [p.id, p.stock]);
    };

    const before = await read();
    await deliverOrder();
    expect(await read()).toEqual(before);
  });

  it('stock changes ONLY through the explicit ERP simulation', async () => {
    const before = sandbox.products.stockSnapshot();
    await deliverOrder();
    expect(sandbox.products.stockSnapshot()).toEqual(before);

    // This is the reseller's own inventory decision - the separate flow.
    sandbox.products.setStock('P-1002', 28);
    sandbox.products.setStock('V-2001', 10);

    const after = sandbox.products.stockSnapshot();
    expect(after['P-1002']).toBe(28);
    expect(after['V-2001']).toBe(10);
  });

  it('setStock takes an ABSOLUTE quantity, never a delta', async () => {
    sandbox.products.setStock('P-1001', 37);
    expect(sandbox.products.stockSnapshot()['P-1001']).toBe(37);

    // Applying the same value again converges rather than accumulating.
    sandbox.products.setStock('P-1001', 37);
    expect(sandbox.products.stockSnapshot()['P-1001']).toBe(37);

    // Zero is a real value, not "unset".
    sandbox.products.setStock('P-1001', 0);
    expect(sandbox.products.stockSnapshot()['P-1001']).toBe(0);
  });

  it('rejects a negative or fractional stock quantity', () => {
    expect(() => sandbox.products.setStock('P-1001', -1)).toThrow(/non-negative integer/);
    expect(() => sandbox.products.setStock('P-1001', 1.5)).toThrow(/non-negative integer/);
  });

  it('the order routes contain no call into the stock API at all', async () => {
    // A structural check on top of the behavioural ones above: if someone ever
    // wires stock into the order flow, this fails even if the arithmetic
    // happens to cancel out.
    const { readFileSync } = await import('node:fs');
    for (const path of ['src/routes/orders.ts', 'src/services/order-service.ts']) {
      const source = readFileSync(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${path} must not touch stock`).not.toMatch(
        /setStock|stock_levels|stockSnapshot/,
      );
    }
  });
});
