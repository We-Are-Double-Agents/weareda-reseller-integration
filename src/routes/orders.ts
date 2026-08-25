/**
 * Order delivery and cancellation (contract 4.3, 4.4)
 *
 * Direction: WeAreDA -> Reseller.
 *
 *   POST /orders                       deliver a confirmed order
 *   POST /orders/{externalOrderId}/cancel
 *   POST /orders/cancel                fallback when WeAreDA holds no id of ours
 *
 * ============================================================================
 * IMPORTANT - contract 6.4
 * None of these routes touches stock. Not on delivery, not on cancellation.
 * Inventory is the reseller's own business and is reported to WeAreDA with a
 * SEPARATE stock.updated webhook carrying ABSOLUTE quantities.
 * ============================================================================
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { addLogNote } from '../middleware/request-logger.js';
import type { OrderService } from '../services/order-service.js';
import { ValidationError } from '../services/order-service.js';
import type { CancelPayload, OrderPayload } from '../weareda/types.js';

const STOCK_REMINDER =
  'Stock unchanged - orders and inventory are independent flows (contract 6.4). ' +
  'Send a separate stock.updated webhook if your ERP recalculated inventory.';

export function registerOrderRoutes(
  app: FastifyInstance,
  config: AppConfig,
  orders: OrderService,
): void {
  const preHandler = requireAuth(config);

  /* ------------------------------------------------------------------ */
  /* POST /orders                                                        */
  /* ------------------------------------------------------------------ */
  app.post<{ Body: OrderPayload }>('/orders', { preHandler }, async (request, reply) => {
    const idempotencyKey = readIdempotencyKey(request);

    let payload: OrderPayload;
    try {
      payload = orders.validate(request.body);
    } catch (error) {
      if (error instanceof ValidationError) {
        addLogNote(request, `Rejected: ${error.details.join('; ')}`);
        // A validation 4xx is NOT retried by WeAreDA - the order is routed to
        // manual_review instead (contract 4.3). Only reject what is genuinely
        // unusable.
        return reply.code(400).send({
          error: 'invalid_order',
          message: error.message,
          details: error.details,
        });
      }
      throw error;
    }

    const result = orders.accept(payload, idempotencyKey);

    if (result.duplicate) {
      addLogNote(
        request,
        [
          '[ORDER]',
          'Duplicate delivery detected.',
          `Idempotency-Key: ${idempotencyKey ?? payload.idempotency_key ?? '(none)'}`,
          `Existing order: ${result.order.id}`,
          'No duplicate order created.',
        ].join(' '),
      );
    } else {
      addLogNote(request, `[ORDER] Created ${result.order.id}. ${STOCK_REMINDER}`);
    }

    // Always return the order id on the first 2xx: without it WeAreDA stores no
    // external_order_id and the per-order cancel path degrades to the fallback
    // endpoint (contract 4.3).
    return reply.code(result.statusCode).send(result.body);
  });

  /* ------------------------------------------------------------------ */
  /* POST /orders/:externalOrderId/cancel                                */
  /* ------------------------------------------------------------------ */
  app.post<{ Params: { externalOrderId: string }; Body: CancelPayload }>(
    '/orders/:externalOrderId/cancel',
    { preHandler },
    async (request, reply) => {
      return handleCancel(request, reply, orders, request.params.externalOrderId);
    },
  );

  /* ------------------------------------------------------------------ */
  /* POST /orders/cancel  (fallback, contract 4.4)                       */
  /* ------------------------------------------------------------------ */
  app.post<{ Body: CancelPayload }>('/orders/cancel', { preHandler }, async (request, reply) => {
    return handleCancel(request, reply, orders, undefined);
  });
}

async function handleCancel(
  request: FastifyRequest<{ Body: CancelPayload }>,
  reply: FastifyReply,
  orders: OrderService,
  externalOrderId: string | undefined,
) {
  const body = (request.body ?? {}) as CancelPayload;
  const idempotencyKey = readIdempotencyKey(request);

  const result = orders.cancel(externalOrderId, body, idempotencyKey);

  if (result.duplicateDelivery) {
    addLogNote(
      request,
      [
        '[CANCEL]',
        'Duplicate cancellation detected.',
        `Idempotency-Key: ${idempotencyKey ?? '(none)'}`,
        `Existing order: ${result.order?.id ?? '(none)'}`,
        'No state change.',
      ].join(' '),
    );
  } else if (result.statusCode === 404) {
    addLogNote(
      request,
      '[CANCEL] No matching order. Returning 404 - WeAreDA treats this as idempotent success (contract 4.4).',
    );
  } else if (result.alreadyCancelled) {
    addLogNote(request, `[CANCEL] ${result.order?.id} was already cancelled. Idempotent no-op.`);
  } else {
    addLogNote(request, `[CANCEL] ${result.order?.id} cancelled. ${STOCK_REMINDER}`);
  }

  return reply.code(result.statusCode).send(result.body);
}

/**
 * The idempotency key arrives in the header AND in the body (contract 5). The
 * header is the canonical location; the body is the fallback.
 */
function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader;
  const body = request.body as { idempotency_key?: unknown } | undefined;
  return typeof body?.idempotency_key === 'string' ? body.idempotency_key : undefined;
}
