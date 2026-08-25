/**
 * The reseller server: everything WeAreDA calls.
 *
 * Direction of every route registered here: WeAreDA -> Reseller.
 *
 *   GET  /                                  test connection      (contract 4.1)
 *   GET  /products                          catalog + stock pull (contract 4.2)
 *   POST /orders                            order delivery       (contract 4.3)
 *   POST /orders/:externalOrderId/cancel    cancellation         (contract 4.4)
 *   POST /orders/cancel                     cancellation fallback(contract 4.4)
 *
 * Plus local-only helpers that are NOT part of the contract:
 *   GET  /healthz                           unauthenticated liveness probe
 *   GET  /fixtures/invoices/*.pdf           invoice document for invoice.issued
 *   GET  /debug/{orders,products,events}    JSON inspection
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { openDatabase, type Database } from './storage/db.js';
import { EventLog } from './services/event-log.js';
import { OrderService } from './services/order-service.js';
import { ProductService } from './services/product-service.js';
import { registerRequestLogging } from './middleware/request-logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProductRoutes } from './routes/products.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerDebugRoutes } from './routes/debug.js';
import { registerFixtureRoutes } from './routes/fixtures.js';
import { setLogLevel } from './lib/logger.js';

export interface SandboxServer {
  app: FastifyInstance;
  db: Database;
  config: AppConfig;
  products: ProductService;
  orders: OrderService;
  eventLog: EventLog;
  close(): Promise<void>;
}

export interface BuildOptions {
  /** Overrides config.databasePath - tests use ':memory:' or a temp file. */
  databasePath?: string;
  catalogPath?: string;
  /** Silences the per-request log blocks in tests. */
  quiet?: boolean;
}

export function buildServer(config: AppConfig, options: BuildOptions = {}): SandboxServer {
  setLogLevel(options.quiet ? 'silent' : config.logLevel);

  const db = openDatabase(options.databasePath ?? config.databasePath);
  const eventLog = new EventLog(db);
  const products = new ProductService(db, options.catalogPath ?? 'data/products.json');
  const orders = new OrderService(db);

  const app = Fastify({
    // Fastify's own logger is off: this sandbox prints its own direction-aware
    // blocks instead (see src/middleware/request-logger.ts).
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
  });

  registerRequestLogging(app, eventLog);

  // A malformed JSON body must not look like an auth or contract failure.
  app.setErrorHandler(async (rawError, request, reply) => {
    const error = rawError as { statusCode?: number; message: string };
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 400) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: error.message,
      });
    }
    if (statusCode >= 500) {
      // Contract 4.3: 5xx is retried by WeAreDA with backoff.
      return reply.code(statusCode).send({ error: 'internal_error', message: error.message });
    }
    return reply.code(statusCode).send({ error: 'request_failed', message: error.message });
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message: `No route for ${request.method} ${request.url}`,
    });
  });

  registerHealthRoutes(app, config);
  registerProductRoutes(app, config, products);
  registerOrderRoutes(app, config, orders);
  registerFixtureRoutes(app);

  if (config.enableDebugEndpoints) {
    registerDebugRoutes(app, { orders, products, eventLog });
  }

  return {
    app,
    db,
    config,
    products,
    orders,
    eventLog,
    async close() {
      await app.close();
      db.close();
    },
  };
}
