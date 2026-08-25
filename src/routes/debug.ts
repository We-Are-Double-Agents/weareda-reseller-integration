/**
 * Local inspection endpoints - JSON only, no HTML, no UI.
 *
 * These are NOT part of the WeAreDA contract. They exist so you can see what
 * the sandbox received and sent during a test. Gated behind
 * ENABLE_DEBUG_ENDPOINTS and unauthenticated on purpose (local use only) -
 * do not expose them from anything resembling production.
 */
import type { FastifyInstance } from 'fastify';
import type { EventLog } from '../services/event-log.js';
import type { OrderService } from '../services/order-service.js';
import type { ProductService } from '../services/product-service.js';

export function registerDebugRoutes(
  app: FastifyInstance,
  deps: { orders: OrderService; products: ProductService; eventLog: EventLog },
): void {
  app.get('/debug/orders', async () => ({
    count: deps.orders.count(),
    orders: deps.orders.list(200),
  }));

  app.get('/debug/products', async () => ({
    products: deps.products.all(),
    stock: deps.products.stockSnapshot(),
  }));

  app.get('/debug/events', async () => ({
    // WeAreDA -> Reseller
    inbound: deps.eventLog.inbound(100),
    // Reseller -> WeAreDA
    outbound: deps.eventLog.outbound(100),
  }));
}
