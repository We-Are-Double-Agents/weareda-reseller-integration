/**
 * Wire types for the WeAreDA reseller integration.
 *
 * Field names mirror the contract exactly (snake_case on the wire). Section
 * references point at RESELLER_INTEGRATION_API_CONTRACT.md.
 */

/* -------------------------------------------------------------------------- */
/* Catalog (contract 4.2 / 6.5) - one serializer, two transports              */
/* -------------------------------------------------------------------------- */

export type ProductStatus = 'active' | 'archived';

export interface ProductVariant {
  id: string;
  sku?: string;
  name?: string;
  attributes?: Record<string, string>;
  price?: number;
  stock?: number;
}

export type ProductImage = string | { src?: string; url?: string; image?: string };

export interface Product {
  id: string;
  sku?: string;
  name: string;
  description?: string;
  price?: number;
  compare_at_price?: number | null;
  currency?: string;
  status?: ProductStatus | string;
  stock?: number;
  images?: ProductImage[];
  updated_at?: string;
  variants?: ProductVariant[];
}

/* -------------------------------------------------------------------------- */
/* Order delivery, WeAreDA -> Reseller (contract 4.3)                          */
/* -------------------------------------------------------------------------- */

export interface OrderItemPayload {
  sku?: string;
  external_product_id?: string;
  external_variant_id?: string;
  name?: string;
  variant_name?: string | null;
  quantity: number;
  unit_price?: number;
  discount?: number;
  subtotal?: number;
}

export interface ShippingAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  phone?: string;
  email?: string;
}

/**
 * Note there is no `external_order_id` here, and no customer object: the
 * delivered payload identifies the order by `order_number` + `idempotency_key`,
 * and the recipient by the shipping address (contract 4.3).
 */
export interface OrderPayload {
  order_number?: string;
  currency?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
  shipping?: number;
  total?: number;
  notes?: string;
  shipping_address?: ShippingAddress;
  idempotency_key?: string;
  items: OrderItemPayload[];
}

/** Contract 4.4 - both the per-order and the fallback cancel path. */
export interface CancelPayload {
  order_number?: string;
  external_order_id?: string;
  reason?: 'cancelled' | 'refunded' | string;
  idempotency_key?: string;
}

/* -------------------------------------------------------------------------- */
/* Webhook events, Reseller -> WeAreDA (contract 6)                            */
/* -------------------------------------------------------------------------- */

export type WeAreDAEventType =
  'order.status' | 'stock.updated' | 'product.updated' | 'invoice.issued';

/**
 * The `state` values WeAreDA maps (contract 6.1). Anything else is accepted by
 * the transport but "not mapped": the event is parked for a human and the
 * order's integration_status is left exactly as it was.
 */
export const MAPPED_ORDER_STATES = [
  'accepted',
  'acknowledged',
  'ack',
  'fulfilled',
  'completed',
  'shipped',
  'delivered',
  'cancelled',
  'canceled',
  'rejected',
  'failed',
  'error',
] as const;

export type MappedOrderState = (typeof MAPPED_ORDER_STATES)[number];

export function mapsToIntegrationStatus(state: string): string | null {
  switch (state) {
    case 'accepted':
    case 'acknowledged':
    case 'ack':
      return 'accepted';
    case 'fulfilled':
    case 'completed':
    case 'shipped':
    case 'delivered':
      return 'completed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'rejected':
    case 'failed':
    case 'error':
      return 'manual_review';
    default:
      return null;
  }
}

export interface OrderStatusEvent {
  type: 'order.status';
  id: string;
  order: {
    external_order_id?: string;
    order_number?: string;
    state: string;
  };
}

export interface StockItem {
  external_product_id?: string;
  external_variant_id?: string;
  sku?: string;
  /** ABSOLUTE on-hand quantity. Never a delta. `0` means sold out. */
  quantity: number;
}

export interface StockUpdatedEvent {
  type: 'stock.updated';
  id: string;
  items: StockItem[];
}

export interface ProductUpdatedEvent {
  type: 'product.updated';
  id: string;
  products: Product[];
}

export interface Invoice {
  external_invoice_id: string;
  number?: string;
  status?: 'issued' | 'paid' | 'cancelled' | 'void' | string;
  currency?: string;
  total?: number;
  issued_at?: string;
  external_order_id?: string;
  order_number?: string;
  document_url?: string;
}

export interface InvoiceIssuedEvent {
  type: 'invoice.issued';
  id: string;
  invoice: Invoice;
}

export type WeAreDAEvent =
  OrderStatusEvent | StockUpdatedEvent | ProductUpdatedEvent | InvoiceIssuedEvent;

/** Contract 6.0 - the one payload container that belongs to each event type. */
export const EVENT_CONTAINER: Record<WeAreDAEventType, string> = {
  'order.status': 'order',
  'stock.updated': 'items',
  'product.updated': 'products',
  'invoice.issued': 'invoice',
};

/** Contract 6.5 - hard caps on a product.updated batch. */
export const PRODUCT_BATCH_MAX_ITEMS = 500;
export const PRODUCT_BATCH_MAX_BYTES = 512 * 1024;

/** Contract 6.0 - webhook response envelope. */
export interface WebhookResponseBody {
  accepted?: boolean;
  deduped?: boolean;
  operationId?: string;
  error?: string;
  max?: number;
}
