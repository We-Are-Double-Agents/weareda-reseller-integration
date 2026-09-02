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
 * A customer's fiscal identification (contract 4.3).
 *
 * `type` is a FREE SHORT TOKEN, NOT AN ENUM. CUIT, CUIL, DNI, CPF, CNPJ, NIF,
 * NIE, CIF, RFC, EIN, SSN, VAT, TAX_ID - and whatever else the next country
 * uses. Meeting a value you have never seen is NORMAL: store it verbatim,
 * never normalise it into a token you do recognise, and never reject the order
 * over it. This is deliberately not a union type, so that nobody can turn it
 * into one without deleting this comment first.
 */
export interface TaxId {
  /** e.g. "CUIT". Free token - see above. */
  type: string;
  /** e.g. "20-12345678-9". Sensitive: mask it before it reaches a log (11.8). */
  value: string;
  /** ISO 3166-1 alpha-2, e.g. "AR". */
  country?: string;
}

/**
 * The customer an order was created for (contract 4.3, added 2026-09).
 *
 * OPTIONAL AND ADDITIVE. The whole key is omitted when the order has no
 * contact, so an integration written before this keeps working untouched.
 *
 * `tax_id` is different: the key is ALWAYS PRESENT inside `customer` and is
 * `null` when the contact has no fiscal identification, so branching on it
 * needs no optional chaining. A defensive reader still tolerates it missing.
 *
 * SNAPSHOT, NOT A LIVE READ (contract 4.3.1). These values were copied onto
 * the order when it was created. They will not necessarily match a later read
 * of the same customer, and a stored order must never be "corrected" from one:
 * an invoice is issued against the identity the order was created with. The
 * one exception is in your favour - an order that arrived with NO fiscal id
 * may later report one, because WeAreDA fills that gap from the contact. The
 * snapshot freezes a value, not an absence.
 */
export interface CustomerPayload {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  /** `null` when the contact has no fiscal identification. Never omitted. */
  tax_id: TaxId | null;
}

/**
 * Note there is no `external_order_id` here: the delivered payload identifies
 * the order by `order_number` + `idempotency_key`, and the recipient by the
 * shipping address (contract 4.3).
 *
 * It DOES carry a `customer` object, with the contact's fiscal identification
 * when the tenant captured one - optional in both senses: `customer` may be
 * absent, and `customer.tax_id` may be `null`.
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
  /** Omitted entirely when the order has no contact (contract 4.3). */
  customer?: CustomerPayload;
  idempotency_key?: string;
  items: OrderItemPayload[];
}

/**
 * The customer of a delivered order, or `null` when it has none.
 *
 * Tolerates every shape a lenient validator lets through, so no caller has to
 * guard (contract 4.3: `customer` absent is an ordinary order).
 */
export function customerOf(payload: OrderPayload | null | undefined): CustomerPayload | null {
  const customer = payload?.customer;
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) return null;
  return customer;
}

/**
 * The fiscal identification of a delivered order, or `null` when there is
 * none. `null` is an ordinary answer, not an error - see `requiresTaxId`
 * (contract 4.3.2) if your billing cannot live with it.
 */
export function taxIdOf(payload: OrderPayload | null | undefined): TaxId | null {
  const taxId = customerOf(payload)?.tax_id;
  if (!taxId || typeof taxId !== 'object' || Array.isArray(taxId)) return null;
  if (typeof taxId.type !== 'string' || typeof taxId.value !== 'string') return null;
  return taxId;
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
 * The `state` values WeAreDA maps (contract 6.1).
 *
 * A `state` is mapped in TWO independent columns:
 *
 *   1. integration_status - always moved, on every integration.
 *   2. orders.status      - the CUSTOMER-FACING status, moved only when the
 *                           tenant opted in with `orderStatusWrite: true`
 *                           at connect time (see integration-mode.ts).
 *
 * Anything outside the table is not mapped at all: the operation is rejected
 * with `unknown_order_state` and the order is left exactly as it was.
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
  'returned',
  'return',
  'refunded',
  'not_delivered',
  'undelivered',
  'rejected',
  'failed',
  'error',
] as const;

export type MappedOrderState = (typeof MAPPED_ORDER_STATES)[number];

/**
 * Column 1 - integration_status. Always applied.
 *
 * Note that `shipped` and `delivered` COLLAPSE here: both are `completed`.
 * That is why the customer-facing column below is derived from the RAW state
 * and never from this value - by the time you have an integration_status you
 * can no longer tell "shipped" from "delivered".
 */
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
    // A return is NOT a cancellation: `cancelled` means never shipped,
    // `returned` means shipped and came back. A return never triggers a
    // cancellation call back to the reseller.
    case 'returned':
    case 'return':
    case 'refunded':
    case 'not_delivered':
    case 'undelivered':
      return 'returned';
    case 'rejected':
    case 'failed':
    case 'error':
      return 'manual_review';
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Column 2 - the customer-facing order status (contract 6.1 opt-in)           */
/* -------------------------------------------------------------------------- */

/**
 * The customer-facing ladder. It only ever ADVANCES: a lower rung arriving
 * after a higher one is a late or reordered event and is ignored, not applied.
 */
export const ORDER_STATUS_LADDER = [
  'draft',
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
] as const;

/**
 * The two exceptions to the ladder. They apply from ANY rung at ANY time,
 * including after shipped/delivered - an order the customer refused on
 * delivery is an ordinary outcome, not an anomaly.
 */
export const ORDER_STATUS_EXCEPTIONS = ['cancelled', 'refunded'] as const;

export type OrderLadderStatus = (typeof ORDER_STATUS_LADDER)[number];
export type OrderExceptionStatus = (typeof ORDER_STATUS_EXCEPTIONS)[number];
export type CustomerOrderStatus = OrderLadderStatus | OrderExceptionStatus;

/**
 * Column 2 - orders.status, derived from the RAW reseller state.
 *
 * `null` means "this state does not move the customer-facing status", which is
 * not the same as "unknown state": `rejected` / `failed` / `error` are mapped
 * (to integration_status manual_review) and deliberately leave orders.status
 * alone.
 *
 * Two mappings worth knowing by heart:
 *   - `fulfilled` -> `shipped`, NOT `delivered`. Deliberately the cheaper wrong
 *     guess: the ladder discards a lower rung arriving later, so guessing the
 *     top rung would permanently throw away the real `delivered` event.
 *   - `returned` and friends -> `refunded`, never `cancelled`.
 */
export function mapsToOrderStatus(state: string): CustomerOrderStatus | null {
  switch (state) {
    case 'accepted':
    case 'acknowledged':
    case 'ack':
      return 'confirmed';
    case 'shipped':
    case 'fulfilled':
      return 'shipped';
    case 'delivered':
    case 'completed':
      return 'delivered';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'returned':
    case 'return':
    case 'refunded':
    case 'not_delivered':
    case 'undelivered':
      return 'refunded';
    default:
      // Includes rejected | failed | error (mapped, but no status effect) and
      // every unmapped value.
      return null;
  }
}

/** Rung index on the ladder, or -1 for a status that is not on it. */
export function ladderRank(status: string): number {
  return (ORDER_STATUS_LADDER as readonly string[]).indexOf(status);
}

export function isExceptionStatus(status: string): status is OrderExceptionStatus {
  return (ORDER_STATUS_EXCEPTIONS as readonly string[]).includes(status);
}

/** Terminal failures reported as integration_operations.last_error_code. */
export const OPERATION_ERROR_CODES = [
  'unknown_order_state',
  'order_not_found',
  'order_status_conflict',
  'integration_disabled',
  'read_calls_disabled',
  'order_delivery_disabled',
] as const;

export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

/** Why the customer-facing status did or did not move. */
export type OrderStatusReason =
  | 'moved'
  | 'status_write_disabled'
  | 'unmapped_state'
  | 'already_current'
  | 'backward'
  | 'conflict'
  | 'unknown_state';

export interface OrderStatusTransition {
  /** `applied` and `unchanged` complete; `rejected` is a terminal failure. */
  outcome: 'applied' | 'unchanged' | 'rejected';
  /** integration_status to write. `null` only when the state is unknown. */
  integrationStatus: string | null;
  /** orders.status to write, or `null` when nothing is written. */
  orderStatus: CustomerOrderStatus | null;
  reason: OrderStatusReason;
  /** integration_operations.result.detail */
  detail: string;
  /** integration_operations.last_error_code, or `null` when the op completed. */
  errorCode: OperationErrorCode | null;
  /**
   * Timestamp column to fill IF IT IS STILL BLANK. Never overwritten: the
   * first `shipped` wins, and a redelivery does not move the date.
   */
  fillTimestamp: 'shipped_at' | 'delivered_at' | null;
}

/**
 * The whole of contract 6.1's decision, in one pure function.
 *
 *   LADDER      draft -> pending -> confirmed -> processing -> shipped -> delivered
 *               Only ever ADVANCES.
 *   EXCEPTIONS  cancelled, refunded - apply from ANY rung at ANY time.
 *
 * A fulfilment step reported for an order WeAreDA already holds as
 * cancelled/refunded is a contradiction between the two systems, not an
 * update: the order is left untouched, integration_status becomes
 * `manual_review`, and the operation is rejected with `order_status_conflict`.
 * Neither side wins automatically.
 *
 * Conflict detection is part of the status-write path, so it only applies when
 * the tenant opted in. With `orderStatusWrite: false` WeAreDA never consults
 * orders.status, so it has no contradiction to notice - that is the pre-opt-in
 * behaviour, unchanged.
 */
export function resolveOrderStatusTransition(input: {
  /** The order's current customer-facing status. */
  currentStatus: string;
  /** The RAW `state` from the reseller's order.status event. */
  state: string;
  /** The tenant's `orderStatusWrite` setting. */
  orderStatusWrite: boolean;
}): OrderStatusTransition {
  const integrationStatus = mapsToIntegrationStatus(input.state);

  // Not in the table at all: nothing is applied, in either column.
  if (integrationStatus === null) {
    return {
      outcome: 'rejected',
      integrationStatus: null,
      orderStatus: null,
      reason: 'unknown_state',
      detail: 'rejected; unknown_order_state',
      errorCode: 'unknown_order_state',
      fillTimestamp: null,
    };
  }

  const unchanged = (reason: OrderStatusReason): OrderStatusTransition => ({
    outcome: 'unchanged',
    integrationStatus,
    orderStatus: null,
    reason,
    detail: `completed; status unchanged (${reason})`,
    errorCode: null,
    fillTimestamp: null,
  });

  if (!input.orderStatusWrite) return unchanged('status_write_disabled');

  const target = mapsToOrderStatus(input.state);
  // Mapped for integration_status, but with no customer-facing meaning:
  // rejected | failed | error.
  if (target === null) return unchanged('unmapped_state');

  if (target === input.currentStatus) return unchanged('already_current');

  const applied = (): OrderStatusTransition => ({
    outcome: 'applied',
    integrationStatus,
    orderStatus: target,
    reason: 'moved',
    detail: `completed; status ${input.currentStatus}→${target}`,
    errorCode: null,
    fillTimestamp:
      target === 'shipped' ? 'shipped_at' : target === 'delivered' ? 'delivered_at' : null,
  });

  // Exceptions ignore the ladder entirely, in both directions of time.
  if (isExceptionStatus(target)) return applied();

  if (isExceptionStatus(input.currentStatus)) {
    return {
      outcome: 'rejected',
      // The order itself is left untouched; only the integration side moves.
      integrationStatus: 'manual_review',
      orderStatus: null,
      reason: 'conflict',
      detail: 'rejected; order_status_conflict',
      errorCode: 'order_status_conflict',
      fillTimestamp: null,
    };
  }

  // Both on the ladder: advance only. An unknown current status ranks below
  // `draft`, so any rung advances it.
  return ladderRank(target) > ladderRank(input.currentStatus) ? applied() : unchanged('backward');
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
