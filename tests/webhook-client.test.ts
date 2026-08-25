/**
 * Outbound delivery - contract 3.2, 5, 6.
 * Direction: Reseller -> WeAreDA.
 *
 * These tests stand up a local receiver that behaves like the WeAreDA webhook
 * endpoint: it verifies the signature over the RAW body it received, dedupes on
 * X-WeAreDA-Event-Id, and answers 202 / 200 {deduped:true} / 400 / 401.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  WeAreDAWebhookClient,
  EventTooLargeError,
  verifySignature,
} from '../src/weareda/webhook-client.js';
import {
  buildInvoiceIssuedEvent,
  buildOrderStatusEvent,
  buildProductUpdatedEvent,
  buildStockUpdatedEvent,
} from '../src/weareda/events.js';
import { testConfig } from './helpers.js';
import { setLogLevel } from '../src/lib/logger.js';
import type { Product } from '../src/weareda/types.js';

const SECRET = 'whsec_test_secret';

interface Received {
  rawBody: string;
  parsed: any;
  signature: string;
  eventId: string;
  timestamp: string | undefined;
  signatureValid: boolean;
  contentType: string | undefined;
}

describe('WeAreDA webhook client (Reseller -> WeAreDA)', () => {
  let receiver: FastifyInstance;
  let url: string;
  let received: Received[] = [];
  const seenEventIds = new Set<string>();
  /** Status codes the receiver should return, consumed one per request. */
  let scriptedStatuses: number[] = [];

  beforeAll(async () => {
    setLogLevel('silent');
    receiver = Fastify({ logger: false });

    // The receiver must see the RAW bytes, exactly like WeAreDA does.
    receiver.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => done(null, { raw: body as string }),
    );

    receiver.post('/webhook', async (request, reply) => {
      const raw = (request.body as { raw: string }).raw;
      const signature = String(request.headers['x-weareda-signature'] ?? '');
      const eventId = String(request.headers['x-weareda-event-id'] ?? '');
      const valid = verifySignature(raw, SECRET, signature);

      received.push({
        rawBody: raw,
        parsed: JSON.parse(raw),
        signature,
        eventId,
        timestamp: request.headers['x-weareda-timestamp'] as string | undefined,
        signatureValid: valid,
        contentType: request.headers['content-type'] as string | undefined,
      });

      if (!valid) return reply.code(401).send({ error: 'unauthorized' });

      const scripted = scriptedStatuses.shift();
      if (scripted && scripted !== 202) {
        return reply.code(scripted).send({ error: 'scripted_failure' });
      }

      if (seenEventIds.has(eventId)) {
        return reply.code(200).send({ deduped: true, operationId: `op_${eventId}` });
      }
      seenEventIds.add(eventId);
      return reply.code(202).send({ accepted: true, operationId: `op_${eventId}` });
    });

    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = receiver.server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/webhook`;
  });

  afterAll(async () => {
    await receiver.close();
  });

  beforeEach(() => {
    received = [];
    scriptedStatuses = [];
    seenEventIds.clear();
  });

  function client(overrides: Record<string, unknown> = {}) {
    const config = testConfig({
      webhook: { url, secret: SECRET, maxAttempts: 3, timeoutMs: 3000, ...overrides },
    } as never);
    return new WeAreDAWebhookClient(config);
  }

  it('delivers a signed event the receiver accepts with 202', async () => {
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1001', quantity: 37 }]),
    );

    expect(result.statusCode).toBe(202);
    expect(result.accepted).toBe(true);
    expect(result.operationId).toMatch(/^op_evt_/);
    expect(received).toHaveLength(1);
    expect(received[0]?.signatureValid).toBe(true);
  });

  it('sends exactly the bytes it signed', async () => {
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1001', quantity: 37 }]),
    );
    expect(received[0]?.rawBody).toBe(result.body);
    expect(verifySignature(received[0]!.rawBody, SECRET, received[0]!.signature)).toBe(true);
  });

  it('sends the documented headers', async () => {
    await client().send(buildOrderStatusEvent({ externalOrderId: 'SO-10001', state: 'shipped' }));
    const call = received[0]!;
    expect(call.contentType).toContain('application/json');
    expect(call.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(call.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(call.eventId).toBe(call.parsed.id);
  });

  it('sends X-WeAreDA-Timestamp as unix seconds inside the replay window', async () => {
    await client().send(buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]));
    const timestamp = Number(received[0]!.timestamp);
    expect(Number.isInteger(timestamp)).toBe(true);
    const skewSeconds = Math.abs(Date.now() / 1000 - timestamp);
    expect(skewSeconds).toBeLessThan(300); // the contract's +/-5 minute window
  });

  it('keeps the event id header and the body id identical when overridden', async () => {
    await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }], 'evt_from_builder'),
      { eventId: 'evt_override' },
    );
    expect(received[0]?.eventId).toBe('evt_override');
    expect(received[0]?.parsed.id).toBe('evt_override');
    // And the signature still covers the bytes actually sent.
    expect(verifySignature(received[0]!.rawBody, SECRET, received[0]!.signature)).toBe(true);
  });

  it('omits X-WeAreDA-Timestamp when asked (the header is optional)', async () => {
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
      { omitTimestamp: true },
    );
    expect(received[0]?.timestamp).toBeUndefined();
    expect(result.statusCode).toBe(202); // still accepted - only the signature is required
  });

  it('is rejected with 401 when the signature does not match the body', async () => {
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
      { corruptSignature: true },
    );
    expect(result.statusCode).toBe(401);
    expect(received[0]?.signatureValid).toBe(false);
  });

  it('gets 200 {deduped:true} when the same event id is delivered twice', async () => {
    const first = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }], 'evt_fixed_id'),
    );
    const second = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }], 'evt_fixed_id'),
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.deduped).toBe(true);
  });

  it('retries a 5xx with the SAME event id and body, so WeAreDA can dedupe it', async () => {
    scriptedStatuses = [500, 503];
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
    );

    expect(result.attempts).toBe(3);
    expect(result.statusCode).toBe(202);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((call) => call.eventId)).size).toBe(1);
    expect(new Set(received.map((call) => call.rawBody)).size).toBe(1);
  });

  it('does not retry a 4xx', async () => {
    scriptedStatuses = [400];
    const result = await client().send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
    );
    expect(result.attempts).toBe(1);
    expect(result.statusCode).toBe(400);
    expect(received).toHaveLength(1);
  });

  it('carries many stock lines in a single request', async () => {
    await client().send(
      buildStockUpdatedEvent([
        { external_product_id: 'P-1001', quantity: 37 },
        { external_variant_id: 'V-2001', quantity: 5 },
        { external_variant_id: 'V-2002', quantity: 0 },
      ]),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.parsed.items).toHaveLength(3);
  });

  it('refuses a product.updated batch over the 500-item cap before sending', async () => {
    const products: Product[] = Array.from({ length: 501 }, (_, index) => ({
      id: `P-${index}`,
      name: `Product ${index}`,
    }));

    await expect(client().send(buildProductUpdatedEvent(products))).rejects.toThrow(
      EventTooLargeError,
    );
    expect(received).toHaveLength(0);
  });

  it('accepts a batch of exactly 500 products', async () => {
    const products: Product[] = Array.from({ length: 500 }, (_, index) => ({
      id: `P-${index}`,
      name: `Product ${index}`,
    }));
    const result = await client().send(buildProductUpdatedEvent(products));
    expect(result.statusCode).toBe(202);
    expect(received[0]?.parsed.products).toHaveLength(500);
  });

  it('refuses a product.updated body over 512 KB before sending', async () => {
    const products: Product[] = Array.from({ length: 200 }, (_, index) => ({
      id: `P-${index}`,
      name: `Product ${index}`,
      description: 'x'.repeat(4000),
    }));
    await expect(client().send(buildProductUpdatedEvent(products))).rejects.toThrow(/512/);
    expect(received).toHaveLength(0);
  });

  it('delivers an invoice.issued event with its document_url', async () => {
    await client().send(
      buildInvoiceIssuedEvent({
        external_invoice_id: 'INV-2026-000123',
        number: 'A-0007',
        status: 'paid',
        currency: 'USD',
        total: 105.0,
        issued_at: '2026-08-25T10:00:00Z',
        external_order_id: 'SO-10001',
        document_url: 'https://sandbox.example.test/fixtures/invoices/demo.pdf',
      }),
    );
    expect(received[0]?.parsed.invoice.document_url).toMatch(/^https:\/\//);
    expect(received[0]?.parsed.type).toBe('invoice.issued');
  });

  it('runs in dry-run mode without sending anything when the webhook is unconfigured', async () => {
    const unconfigured = new WeAreDAWebhookClient(
      testConfig({ webhook: { url: '', secret: '', maxAttempts: 1, timeoutMs: 1000 } } as never),
    );
    const result = await unconfigured.send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
    );

    expect(result.dryRun).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(received).toHaveLength(0);
    // The body is still fully serialized, so a dry run shows the real payload.
    expect(JSON.parse(result.body).type).toBe('stock.updated');
  });

  it('reports a network failure without throwing', async () => {
    const offline = new WeAreDAWebhookClient(
      testConfig({
        webhook: {
          url: 'http://127.0.0.1:1/webhook',
          secret: SECRET,
          maxAttempts: 2,
          timeoutMs: 500,
        },
      } as never),
    );
    const result = await offline.send(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.attempts).toBe(2);
  });
});
