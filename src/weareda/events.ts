/**
 * Builders for the four inbound event types (contract 6).
 *
 * Each builder produces a complete event with a fresh event id and EXACTLY the
 * one payload container its type owns. Because a builder can only ever produce
 * one type, contract 6.0 ("one event type per HTTP request") is satisfied by
 * construction - there is no API here that could mix `order` and `items`.
 */
import { newEventId } from '../lib/ids.js';
import type {
  Invoice,
  InvoiceIssuedEvent,
  OrderStatusEvent,
  Product,
  ProductUpdatedEvent,
  StockItem,
  StockUpdatedEvent,
} from './types.js';

/**
 * order.status (contract 6.1)
 *
 * Send ONE event PER TRANSITION, each with its own event id: accepted, then
 * shipped, then delivered. Never changes stock on WeAreDA's side.
 */
export function buildOrderStatusEvent(input: {
  externalOrderId?: string;
  orderNumber?: string;
  state: string;
  eventId?: string;
}): OrderStatusEvent {
  if (!input.externalOrderId && !input.orderNumber) {
    throw new Error('order.status needs external_order_id (preferred) or order_number');
  }
  return {
    type: 'order.status',
    id: input.eventId ?? newEventId(),
    order: {
      ...(input.externalOrderId ? { external_order_id: input.externalOrderId } : {}),
      ...(input.orderNumber ? { order_number: input.orderNumber } : {}),
      state: input.state,
    },
  };
}

/**
 * stock.updated (contract 6.2)
 *
 * `quantity` is the new ABSOLUTE on-hand quantity.
 *   quantity: 37  means  "there are now 37"
 *   quantity: 37  does NOT mean  "add 37"
 *   quantity: 0   is valid and means sold out - it is applied, not ignored.
 *
 * One event should carry EVERY affected product and variant. Batching is the
 * intended usage, not an optimisation: sending one webhook per product is
 * wasteful for both sides.
 */
export function buildStockUpdatedEvent(items: StockItem[], eventId?: string): StockUpdatedEvent {
  if (items.length === 0) {
    throw new Error('stock.updated needs at least one item');
  }
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new Error(
        `stock quantity must be a non-negative integer (absolute on-hand), received ${item.quantity}`,
      );
    }
    if (!item.external_product_id && !item.external_variant_id && !item.sku) {
      throw new Error(
        'each stock line needs external_variant_id, external_product_id or sku (resolved in that order)',
      );
    }
  }
  return { type: 'stock.updated', id: eventId ?? newEventId(), items };
}

/**
 * product.updated (contract 6.5)
 *
 * A push says "here is what CHANGED" - never "here is everything I have".
 * WeAreDA therefore never archives a product just because it was absent from a
 * batch. To retire a product, send it with status "archived".
 *
 * The items are exactly the objects GET /products would return, which is why
 * both transports share ProductService.serialize().
 */
export function buildProductUpdatedEvent(
  products: Product[],
  eventId?: string,
): ProductUpdatedEvent {
  if (products.length === 0) {
    throw new Error('product.updated needs at least one product');
  }
  return { type: 'product.updated', id: eventId ?? newEventId(), products };
}

/**
 * invoice.issued (contract 6.3)
 *
 * `document_url`, when present, must serve a PDF over HTTPS that WeAreDA can
 * fetch, and its host must be allow-listed in sync_config.documentHosts.
 * Re-sending the same external_invoice_id updates the invoice in place.
 */
export function buildInvoiceIssuedEvent(invoice: Invoice, eventId?: string): InvoiceIssuedEvent {
  if (!invoice.external_invoice_id) {
    throw new Error('invoice.issued needs external_invoice_id');
  }
  return { type: 'invoice.issued', id: eventId ?? newEventId(), invoice };
}
