/**
 * Local event history and the debug inspection endpoints.
 *
 * Not part of the WeAreDA contract - this is the sandbox's own record of what
 * crossed the boundary during a test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestSandbox,
  orderPayload,
  TEST_API_KEY,
  type TestSandbox,
} from './helpers.js';
import { WeAreDAWebhookClient } from '../src/weareda/webhook-client.js';
import { buildStockUpdatedEvent } from '../src/weareda/events.js';
import { setLogLevel } from '../src/lib/logger.js';

describe('event history and debug endpoints', () => {
  let sandbox: TestSandbox;

  beforeEach(() => {
    setLogLevel('silent');
    sandbox = createTestSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('records every inbound request with status, timing and idempotency key', async () => {
    await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders({ 'idempotency-key': 'order:6b1e' }),
      payload: orderPayload(),
    });

    const [entry] = sandbox.eventLog.inbound(1);
    expect(entry).toMatchObject({ method: 'POST', path: '/orders', status_code: 201 });
    expect(entry?.idempotency_key).toBe('order:6b1e');
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
    expect((entry?.request_body as { order_number: string }).order_number).toBe('ORD-1042');
    expect((entry?.response_body as { id: string }).id).toMatch(/^SO-/);
  });

  it('never stores the inbound credential in the history', async () => {
    await sandbox.app.inject({ method: 'GET', url: '/', headers: authHeaders() });
    const dump = JSON.stringify(sandbox.eventLog.inbound(10));
    expect(dump).not.toContain(TEST_API_KEY);
  });

  it('records outbound webhooks with their event id, type and dry-run flag', async () => {
    const client = new WeAreDAWebhookClient(sandbox.config, sandbox.eventLog);
    await client.send(buildStockUpdatedEvent([{ external_product_id: 'P-1001', quantity: 37 }]));

    const [entry] = sandbox.eventLog.outbound(1);
    expect(entry?.event_type).toBe('stock.updated');
    expect(entry?.id).toMatch(/^evt_/);
    expect(entry?.dry_run).toBe(true); // no webhook URL configured in tests
    expect((entry?.payload as { items: unknown[] }).items).toHaveLength(1);
  });

  it('never stores a signature or the webhook secret', async () => {
    const client = new WeAreDAWebhookClient(sandbox.config, sandbox.eventLog);
    await client.send(buildStockUpdatedEvent([{ external_product_id: 'P-1001', quantity: 1 }]));
    const dump = JSON.stringify(sandbox.eventLog.outbound(10));
    expect(dump).not.toContain(sandbox.config.webhook.secret);
    expect(dump.toLowerCase()).not.toContain('sha256=');
  });

  it('exposes orders, products and events as JSON', async () => {
    await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders({ 'idempotency-key': 'order:6b1e' }),
      payload: orderPayload(),
    });

    const orders = await sandbox.app.inject({ method: 'GET', url: '/debug/orders' });
    expect(orders.statusCode).toBe(200);
    expect(orders.json().count).toBe(1);

    const products = await sandbox.app.inject({ method: 'GET', url: '/debug/products' });
    expect(products.json().stock['P-1001']).toBe(42);

    const events = await sandbox.app.inject({ method: 'GET', url: '/debug/events' });
    expect(Array.isArray(events.json().inbound)).toBe(true);
    expect(Array.isArray(events.json().outbound)).toBe(true);
  });

  it('does not register the debug endpoints when disabled', async () => {
    const locked = createTestSandbox({ enableDebugEndpoints: false });
    const response = await locked.app.inject({ method: 'GET', url: '/debug/orders' });
    expect(response.statusCode).toBe(404);
    await locked.cleanup();
  });

  it('serves the invoice fixture as a PDF and refuses path traversal', async () => {
    const pdf = await sandbox.app.inject({ method: 'GET', url: '/fixtures/invoices/demo.pdf' });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const traversal = await sandbox.app.inject({
      method: 'GET',
      url: '/fixtures/invoices/..%2F..%2F.env',
    });
    expect(traversal.statusCode).toBe(404);
  });
});
