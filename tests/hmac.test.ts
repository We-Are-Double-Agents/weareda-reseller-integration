/**
 * Webhook signing - contract 3.2.
 * Direction: Reseller -> WeAreDA.
 *
 * The signature is HMAC-SHA256 over the EXACT RAW BODY BYTES that are sent.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSingleEventType,
  computeSignature,
  verifySignature,
  WebhookConfigurationError,
} from '../src/weareda/webhook-client.js';
import {
  buildInvoiceIssuedEvent,
  buildOrderStatusEvent,
  buildProductUpdatedEvent,
  buildStockUpdatedEvent,
} from '../src/weareda/events.js';
import { isoTimestamp, newEventId } from '../src/lib/ids.js';

describe('HMAC signature (contract 3.2)', () => {
  const SECRET = 'whsec_example';

  it('matches a known test vector', () => {
    // Independently reproducible:
    //   echo -n '{"type":"stock.updated"}' | openssl dgst -sha256 -hmac whsec_example
    const body = '{"type":"stock.updated"}';
    const expected = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

    expect(computeSignature(body, SECRET)).toBe(`sha256=${expected}`);
    expect(computeSignature(body, SECRET)).toBe(
      'sha256=59ecfeafb6ffef8700b4508d9b4bf005f3a96dca54114ded45b4d3a79a7f547d',
    );
  });

  it('is prefixed with "sha256=" and hex-encoded', () => {
    const signature = computeSignature('{}', SECRET);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('changes when the body changes by a single byte', () => {
    expect(computeSignature('{"a":1}', SECRET)).not.toBe(computeSignature('{"a":2}', SECRET));
  });

  it('changes when the secret changes', () => {
    expect(computeSignature('{"a":1}', SECRET)).not.toBe(computeSignature('{"a":1}', 'other'));
  });

  it('verifies a signature it produced', () => {
    const body = JSON.stringify(
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 5 }]),
    );
    expect(verifySignature(body, SECRET, computeSignature(body, SECRET))).toBe(true);
  });

  it('rejects a signature computed over different bytes', () => {
    const signed = '{"type":"stock.updated","id":"evt_1"}';
    const sent = '{"id":"evt_1","type":"stock.updated"}'; // same data, different bytes
    expect(verifySignature(sent, SECRET, computeSignature(signed, SECRET))).toBe(false);
  });

  it('rejects a truncated or padded signature without throwing', () => {
    const body = '{}';
    const valid = computeSignature(body, SECRET);
    expect(verifySignature(body, SECRET, valid.slice(0, -1))).toBe(false);
    expect(verifySignature(body, SECRET, `${valid}0`)).toBe(false);
    expect(verifySignature(body, SECRET, '')).toBe(false);
  });

  it('signs the exact bytes of a re-serialization only when they are identical', () => {
    // The trap this rule exists for: JSON.stringify of a parsed object can
    // legitimately produce different bytes than the original string.
    const original = '{"type":"stock.updated","id":"evt_1","items":[{"quantity":1.0}]}';
    const reserialized = JSON.stringify(JSON.parse(original));

    expect(reserialized).not.toBe(original); // 1.0 -> 1
    expect(computeSignature(reserialized, SECRET)).not.toBe(computeSignature(original, SECRET));
  });
});

describe('event ids and timestamps', () => {
  it('generates an evt_-prefixed id with 32 hex characters', () => {
    expect(newEventId()).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  it('generates a distinct id per event', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newEventId()));
    expect(ids.size).toBe(500);
  });

  it('gives every transition its own event id', () => {
    const accepted = buildOrderStatusEvent({ externalOrderId: 'SO-10001', state: 'accepted' });
    const shipped = buildOrderStatusEvent({ externalOrderId: 'SO-10001', state: 'shipped' });
    expect(accepted.id).not.toBe(shipped.id);
  });

  it('reuses an explicitly supplied id (so a retry repeats it)', () => {
    const event = buildStockUpdatedEvent(
      [{ external_product_id: 'P-1', quantity: 1 }],
      'evt_fixed',
    );
    expect(event.id).toBe('evt_fixed');
  });

  it('formats timestamps as RFC3339 UTC with a Z suffix', () => {
    expect(isoTimestamp(new Date('2026-08-25T12:00:00.123Z'))).toBe('2026-08-25T12:00:00Z');
    expect(isoTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('one event type per HTTP request (contract 6.0)', () => {
  it('accepts a well-formed single-type event', () => {
    expect(() =>
      assertSingleEventType(
        buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]) as never,
      ),
    ).not.toThrow();
  });

  it('rejects a body mixing order.status and stock.updated', () => {
    const mixed = {
      type: 'order.status',
      id: 'evt_1',
      order: { external_order_id: 'SO-1', state: 'fulfilled' },
      items: [{ external_product_id: 'P-1', quantity: 37 }],
    };
    expect(() => assertSingleEventType(mixed)).toThrow(WebhookConfigurationError);
    expect(() => assertSingleEventType(mixed)).toThrow(/multiple_event_types/);
  });

  it('rejects a batch envelope', () => {
    expect(() =>
      assertSingleEventType({ events: [{ type: 'order.status' }, { type: 'stock.updated' }] }),
    ).toThrow(/no batch envelope/i);
  });

  it('rejects a missing or unknown top-level type', () => {
    expect(() => assertSingleEventType({ order: {} })).toThrow(/unsupported_event/);
    expect(() => assertSingleEventType({ type: 'order.created', order: {} })).toThrow(
      /unsupported_event/,
    );
  });

  it('rejects an event missing its own payload container', () => {
    expect(() => assertSingleEventType({ type: 'stock.updated', id: 'evt_1' })).toThrow(
      /missing its "items"/,
    );
  });

  it('builders can only ever produce one type', () => {
    const events = [
      buildOrderStatusEvent({ externalOrderId: 'SO-1', state: 'shipped' }),
      buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1 }]),
      buildProductUpdatedEvent([{ id: 'P-1', name: 'X' }]),
      buildInvoiceIssuedEvent({ external_invoice_id: 'INV-1' }),
    ];
    for (const event of events) {
      expect(() => assertSingleEventType(event as never)).not.toThrow();
      const containers = ['order', 'items', 'products', 'invoice'].filter((key) => key in event);
      expect(containers).toHaveLength(1);
    }
  });
});

describe('event builder validation', () => {
  it('refuses a stock quantity that is not a non-negative integer', () => {
    expect(() => buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: -1 }])).toThrow(
      /non-negative integer/,
    );
    expect(() => buildStockUpdatedEvent([{ external_product_id: 'P-1', quantity: 1.5 }])).toThrow(
      /non-negative integer/,
    );
  });

  it('accepts quantity 0 (sold out is a real value)', () => {
    const event = buildStockUpdatedEvent([{ external_product_id: 'P-1003', quantity: 0 }]);
    expect(event.items[0]?.quantity).toBe(0);
  });

  it('refuses a stock line with no product, variant or sku reference', () => {
    expect(() => buildStockUpdatedEvent([{ quantity: 5 } as never])).toThrow(/external_variant_id/);
  });

  it('carries many products and variants in ONE event', () => {
    const event = buildStockUpdatedEvent([
      { external_product_id: 'P-1001', quantity: 37 },
      { external_variant_id: 'V-2001', quantity: 5 },
      { sku: 'WIDGET-BLK', quantity: 12 },
    ]);
    expect(event.items).toHaveLength(3);
    expect(event.type).toBe('stock.updated');
  });

  it('refuses an order.status with no order reference', () => {
    expect(() => buildOrderStatusEvent({ state: 'shipped' })).toThrow(/external_order_id/);
  });

  it('refuses an invoice with no external_invoice_id', () => {
    expect(() => buildInvoiceIssuedEvent({} as never)).toThrow(/external_invoice_id/);
  });
});
