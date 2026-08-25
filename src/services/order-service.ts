/**
 * Order service - the reseller side of contract 4.3 / 4.4.
 *
 * ============================================================================
 * IMPORTANT - THE RULE THIS FILE EXISTS TO DEMONSTRATE (contract 6.4)
 * ============================================================================
 * Receiving an order does NOT decrement stock.
 * Cancelling an order does NOT restore stock.
 * There is deliberately no call to ProductService.setStock() anywhere in this
 * file. Inventory is owned by the reseller system and is reported to WeAreDA
 * through a SEPARATE stock.updated webhook with ABSOLUTE quantities.
 * ============================================================================
 */
import type { Database } from '../storage/db.js';
import { nextCounter } from '../storage/db.js';
import type { CancelPayload, OrderPayload } from '../weareda/types.js';
import { isoNow } from '../lib/ids.js';

export const FIRST_ORDER_NUMBER = 10_001;

export type OrderStatus = 'received' | 'cancelled';

export interface StoredOrder {
  id: string;
  order_number: string | null;
  idempotency_key: string | null;
  status: OrderStatus;
  currency: string | null;
  total: number | null;
  payload: OrderPayload;
  received_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface OrderAcceptedResult {
  order: StoredOrder;
  duplicate: boolean;
  statusCode: 200 | 201;
  body: { id: string; status: string; order_number?: string };
}

export interface CancelResult {
  order: StoredOrder | null;
  alreadyCancelled: boolean;
  duplicateDelivery: boolean;
  statusCode: 200 | 404;
  body: Record<string, unknown>;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface OrderRow {
  id: string;
  order_number: string | null;
  idempotency_key: string | null;
  idempotency_suffix: string | null;
  status: OrderStatus;
  currency: string | null;
  total: number | null;
  payload: string;
  received_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

/**
 * WeAreDA derives both keys from the same order id:
 *   delivery     -> "order:<orderId>"
 *   cancellation -> "order-cancel:<orderId>"
 * Stripping the prefix lets the cancel path find the order that was delivered
 * under the sibling key (contract 4.4 fallback matching).
 */
export function idempotencySuffix(key: string | undefined | null): string | null {
  if (!key) return null;
  const match = /^(order-cancel|order):(.+)$/.exec(key);
  return match ? (match[2] ?? null) : key;
}

export class OrderService {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* Validation (contract 4.3)                                              */
  /* ---------------------------------------------------------------------- */

  validate(payload: unknown): OrderPayload {
    const details: string[] = [];

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ValidationError('Order payload must be a JSON object', [
        'body must be a JSON object',
      ]);
    }

    const order = payload as Record<string, unknown>;

    if (!Array.isArray(order.items) || order.items.length === 0) {
      details.push('items must be a non-empty array');
    } else {
      order.items.forEach((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
          details.push(`items[${index}] must be an object`);
          return;
        }
        const item = raw as Record<string, unknown>;
        const quantity = item.quantity;
        if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
          details.push(`items[${index}].quantity must be a positive number`);
        }
        const hasReference =
          typeof item.external_product_id === 'string' ||
          typeof item.external_variant_id === 'string' ||
          typeof item.sku === 'string';
        if (!hasReference) {
          details.push(
            `items[${index}] must carry one of external_product_id, external_variant_id or sku`,
          );
        }
      });
    }

    // The order must be identifiable, otherwise later order.status events and
    // the fallback cancel path have nothing to match on (contract 4.3, 4.4).
    if (typeof order.order_number !== 'string' && typeof order.idempotency_key !== 'string') {
      details.push('order_number or idempotency_key is required');
    }

    if (order.currency !== undefined && typeof order.currency !== 'string') {
      details.push('currency must be a string when present');
    }

    if (details.length > 0) {
      throw new ValidationError('Order payload failed validation', details);
    }

    return order as unknown as OrderPayload;
  }

  /* ---------------------------------------------------------------------- */
  /* Order delivery (contract 4.3)                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Accepts a delivered order idempotently.
   *
   * On a repeated delivery the contract allows either `409` or `200` with the
   * same order. This reference returns `200` with the existing order, because a
   * `409` carries no order id and WeAreDA therefore stores no external_order_id
   * from it (contract 4.3, response table).
   */
  accept(payload: OrderPayload, headerKey: string | undefined): OrderAcceptedResult {
    const idempotencyKey = headerKey ?? payload.idempotency_key ?? null;

    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey('order', idempotencyKey);
      if (existing) {
        return {
          order: existing,
          duplicate: true,
          statusCode: 200,
          body: {
            id: existing.id,
            status: existing.status === 'cancelled' ? 'cancelled' : 'received',
            ...(existing.order_number ? { order_number: existing.order_number } : {}),
          },
        };
      }
    }

    const id = this.nextOrderId();
    const receivedAt = isoNow();

    // IMPORTANT:
    // The order is stored, and that is all that happens. No stock is touched
    // here - see the header of this file and contract 6.4.
    this.db
      .prepare(
        `INSERT INTO orders
           (id, order_number, idempotency_key, idempotency_suffix, status, currency, total, payload, received_at)
         VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
      )
      .run(
        id,
        payload.order_number ?? null,
        idempotencyKey,
        idempotencySuffix(idempotencyKey),
        payload.currency ?? null,
        payload.total ?? null,
        JSON.stringify(payload),
        receivedAt,
      );

    const order = this.findById(id);
    if (!order) throw new Error(`order ${id} disappeared right after insert`);

    return {
      order,
      duplicate: false,
      statusCode: 201,
      // "Always return your order id" - contract 4.3. WeAreDA reads `id`,
      // `order_id` or `external_order_id`; `id` is the documented default.
      body: {
        id: order.id,
        status: 'received',
        ...(order.order_number ? { order_number: order.order_number } : {}),
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Cancellation (contract 4.4)                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Cancels an order idempotently.
   *
   * Contract 4.4: WeAreDA treats `404` (we don't have it) and `409` (already
   * cancelled) as idempotent success. This reference returns `200` for an
   * already-cancelled order - clearer in a demo, and equally valid - and a
   * genuine `404` only when no order matches at all.
   *
   * IMPORTANT: no stock is restored here. If the cancellation returns units to
   * inventory, that is an internal ERP decision reported separately through
   * stock.updated (contract 4.4, 6.4).
   */
  cancel(
    externalOrderId: string | undefined,
    payload: CancelPayload,
    headerKey: string | undefined,
  ): CancelResult {
    const idempotencyKey = headerKey ?? payload.idempotency_key ?? null;

    if (idempotencyKey) {
      const replay = this.readIdempotencyRecord('cancel', idempotencyKey);
      if (replay) {
        return {
          order: replay.order_id ? this.findById(replay.order_id) : null,
          alreadyCancelled: true,
          duplicateDelivery: true,
          statusCode: replay.status_code === 404 ? 404 : 200,
          body: JSON.parse(replay.response_body) as Record<string, unknown>,
        };
      }
    }

    const order = this.lookup({
      resellerOrderId: externalOrderId ?? payload.external_order_id,
      orderNumber: payload.order_number,
      idempotencyKey,
    });

    if (!order) {
      const body = {
        status: 'not_found',
        message:
          'No matching order. WeAreDA treats 404 on cancel as idempotent success (contract 4.4).',
      };
      if (idempotencyKey) this.writeIdempotencyRecord('cancel', idempotencyKey, null, 404, body);
      return {
        order: null,
        alreadyCancelled: false,
        duplicateDelivery: false,
        statusCode: 404,
        body,
      };
    }

    const alreadyCancelled = order.status === 'cancelled';

    if (!alreadyCancelled) {
      this.db
        .prepare(
          `UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ? WHERE id = ?`,
        )
        .run(isoNow(), payload.reason ?? 'cancelled', order.id);
    }

    const updated = this.findById(order.id) as StoredOrder;
    const body = {
      id: updated.id,
      status: 'cancelled',
      already_cancelled: alreadyCancelled,
      ...(updated.order_number ? { order_number: updated.order_number } : {}),
    };

    if (idempotencyKey)
      this.writeIdempotencyRecord('cancel', idempotencyKey, updated.id, 200, body);

    return {
      order: updated,
      alreadyCancelled,
      duplicateDelivery: false,
      statusCode: 200,
      body,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Lookup helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Contract 4.4: the per-order path carries the id WE returned, the fallback
   * path matches by order_number or idempotency_key. All three are supported,
   * most specific first.
   */
  lookup(keys: {
    resellerOrderId?: string | undefined;
    orderNumber?: string | undefined;
    idempotencyKey?: string | null;
  }): StoredOrder | null {
    if (keys.resellerOrderId) {
      const byId = this.findById(keys.resellerOrderId);
      if (byId) return byId;
    }
    if (keys.orderNumber) {
      const byNumber = this.findByOrderNumber(keys.orderNumber);
      if (byNumber) return byNumber;
    }
    if (keys.idempotencyKey) {
      const byKey = this.findByIdempotencyKey('cancel', keys.idempotencyKey);
      if (byKey) return byKey;
    }
    return null;
  }

  findById(id: string): StoredOrder | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as
      OrderRow | undefined;
    return row ? toStoredOrder(row) : null;
  }

  findByOrderNumber(orderNumber: string): StoredOrder | null {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE order_number = ? ORDER BY received_at DESC LIMIT 1')
      .get(orderNumber) as OrderRow | undefined;
    return row ? toStoredOrder(row) : null;
  }

  /**
   * Matches on the exact key first, then on the shared suffix so that
   * `order-cancel:6b1e` finds the order delivered as `order:6b1e`.
   */
  findByIdempotencyKey(_scope: 'order' | 'cancel', key: string): StoredOrder | null {
    const exact = this.db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key) as
      OrderRow | undefined;
    if (exact) return toStoredOrder(exact);

    const suffix = idempotencySuffix(key);
    if (!suffix) return null;
    const bySuffix = this.db
      .prepare(
        'SELECT * FROM orders WHERE idempotency_suffix = ? ORDER BY received_at DESC LIMIT 1',
      )
      .get(suffix) as OrderRow | undefined;
    return bySuffix ? toStoredOrder(bySuffix) : null;
  }

  list(limit = 100): StoredOrder[] {
    const rows = this.db
      .prepare('SELECT * FROM orders ORDER BY received_at DESC LIMIT ?')
      .all(limit) as unknown as OrderRow[];
    return rows.map(toStoredOrder);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
    return row.n;
  }

  /* ---------------------------------------------------------------------- */
  /* Idempotency records                                                     */
  /* ---------------------------------------------------------------------- */

  private readIdempotencyRecord(
    scope: 'order' | 'cancel',
    key: string,
  ): { order_id: string | null; status_code: number; response_body: string } | undefined {
    return this.db
      .prepare(
        'SELECT order_id, status_code, response_body FROM idempotency_records WHERE scope = ? AND key = ?',
      )
      .get(scope, key) as
      { order_id: string | null; status_code: number; response_body: string } | undefined;
  }

  private writeIdempotencyRecord(
    scope: 'order' | 'cancel',
    key: string,
    orderId: string | null,
    statusCode: number,
    body: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_records (scope, key, order_id, status_code, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO NOTHING`,
      )
      .run(scope, key, orderId, statusCode, JSON.stringify(body), isoNow());
  }

  private nextOrderId(): string {
    return `SO-${nextCounter(this.db, 'order_id', FIRST_ORDER_NUMBER)}`;
  }
}

function toStoredOrder(row: OrderRow): StoredOrder {
  return {
    id: row.id,
    order_number: row.order_number,
    idempotency_key: row.idempotency_key,
    status: row.status,
    currency: row.currency,
    total: row.total,
    payload: JSON.parse(row.payload) as OrderPayload,
    received_at: row.received_at,
    cancelled_at: row.cancelled_at,
    cancellation_reason: row.cancellation_reason,
  };
}
