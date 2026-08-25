/**
 * Order cancellation - contract 4.4.
 * Direction: WeAreDA -> Reseller.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestSandbox, orderPayload, type TestSandbox } from './helpers.js';

describe('order cancellation (WeAreDA -> Reseller)', () => {
  let sandbox: TestSandbox;

  beforeEach(async () => {
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
    return response.json().id as string;
  }

  async function cancel(url: string, payload: object, idempotencyKey?: string) {
    const response = await sandbox.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      payload,
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('cancels via the per-order path', async () => {
    const orderId = await deliverOrder();
    const { statusCode, body } = await cancel(
      `/orders/${orderId}/cancel`,
      { external_order_id: orderId, reason: 'cancelled', idempotency_key: 'order-cancel:6b1e' },
      'order-cancel:6b1e',
    );

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ id: orderId, status: 'cancelled', already_cancelled: false });
    expect(sandbox.orders.findById(orderId)?.status).toBe('cancelled');
  });

  it('stores the cancellation reason', async () => {
    const orderId = await deliverOrder();
    await cancel(`/orders/${orderId}/cancel`, { reason: 'refunded' }, 'order-cancel:r');
    expect(sandbox.orders.findById(orderId)?.cancellation_reason).toBe('refunded');
    expect(sandbox.orders.findById(orderId)?.cancelled_at).toBeTypeOf('string');
  });

  describe('idempotency', () => {
    it('is a no-op when the same cancellation is delivered twice', async () => {
      const orderId = await deliverOrder();
      const first = await cancel(
        `/orders/${orderId}/cancel`,
        { external_order_id: orderId, idempotency_key: 'order-cancel:6b1e' },
        'order-cancel:6b1e',
      );
      const second = await cancel(
        `/orders/${orderId}/cancel`,
        { external_order_id: orderId, idempotency_key: 'order-cancel:6b1e' },
        'order-cancel:6b1e',
      );

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(sandbox.orders.findById(orderId)?.status).toBe('cancelled');
    });

    it('reports already_cancelled when the same order is cancelled under a new key', async () => {
      const orderId = await deliverOrder();
      await cancel(`/orders/${orderId}/cancel`, {}, 'order-cancel:first');
      const second = await cancel(`/orders/${orderId}/cancel`, {}, 'order-cancel:second');
      expect(second.statusCode).toBe(200);
      expect(second.body.already_cancelled).toBe(true);
    });

    it('records the duplicate in the local history', async () => {
      const orderId = await deliverOrder();
      await cancel(`/orders/${orderId}/cancel`, {}, 'order-cancel:6b1e');
      await cancel(`/orders/${orderId}/cancel`, {}, 'order-cancel:6b1e');
      const notes = sandbox.eventLog
        .inbound(10)
        .map((entry) => entry.note ?? '')
        .join('\n');
      expect(notes).toContain('Duplicate cancellation detected');
    });
  });

  describe('fallback endpoint POST /orders/cancel', () => {
    it('matches by order_number', async () => {
      const orderId = await deliverOrder();
      const { statusCode, body } = await cancel('/orders/cancel', {
        order_number: 'ORD-1042',
        reason: 'cancelled',
      });
      expect(statusCode).toBe(200);
      expect(body.id).toBe(orderId);
      expect(sandbox.orders.findById(orderId)?.status).toBe('cancelled');
    });

    it('matches by idempotency_key, including the order-cancel: sibling of order:', async () => {
      // Delivery used "order:6b1e"; cancellation uses "order-cancel:6b1e".
      const orderId = await deliverOrder('order:6b1e');
      const { statusCode, body } = await cancel(
        '/orders/cancel',
        { idempotency_key: 'order-cancel:6b1e' },
        'order-cancel:6b1e',
      );
      expect(statusCode).toBe(200);
      expect(body.id).toBe(orderId);
    });

    it('matches by external_order_id in the body', async () => {
      const orderId = await deliverOrder();
      const { body } = await cancel('/orders/cancel', { external_order_id: orderId });
      expect(body.id).toBe(orderId);
    });
  });

  describe('unknown orders', () => {
    it('returns 404, which WeAreDA treats as idempotent success', async () => {
      const { statusCode, body } = await cancel('/orders/cancel', { order_number: 'NOPE' });
      expect(statusCode).toBe(404);
      expect(body.status).toBe('not_found');
    });

    it('returns 404 on the per-order path for an unknown id', async () => {
      const { statusCode } = await cancel('/orders/SO-99999/cancel', {});
      expect(statusCode).toBe(404);
    });

    it('replays the same 404 for a repeated unknown cancellation', async () => {
      const first = await cancel('/orders/cancel', { order_number: 'NOPE' }, 'order-cancel:ghost');
      const second = await cancel('/orders/cancel', { order_number: 'NOPE' }, 'order-cancel:ghost');
      expect(first.statusCode).toBe(404);
      expect(second.statusCode).toBe(404);
    });
  });
});
