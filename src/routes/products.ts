/**
 * GET /products - product & stock pull (contract 4.2)
 *
 * Direction: WeAreDA -> Reseller.
 *
 * Pagination is page-number based: WeAreDA requests page=1,2,... until a page
 * returns FEWER items than `limit`. Incremental syncs add `updated_since`.
 *
 * This endpoint is only required in the default `pull` mode. In
 * `sync_config.products.mode = "push"` WeAreDA never calls it and your catalog
 * arrives as product.updated events instead - the sandbox implements both, and
 * both use the same serializer (contract 6.5).
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import type { ProductService } from '../services/product-service.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../services/product-service.js';
import { addLogNote } from '../middleware/request-logger.js';

interface ProductQuery {
  page?: string;
  limit?: string;
  updated_since?: string;
}

export function registerProductRoutes(
  app: FastifyInstance,
  config: AppConfig,
  products: ProductService,
): void {
  app.get<{ Querystring: ProductQuery }>(
    '/products',
    { preHandler: requireAuth(config) },
    async (request, reply) => {
      const page = parsePositiveInt(request.query.page, 1);
      const limit = Math.min(
        MAX_PAGE_SIZE,
        parsePositiveInt(request.query.limit, DEFAULT_PAGE_SIZE),
      );
      const updatedSince = request.query.updated_since;

      if (updatedSince !== undefined && Number.isNaN(new Date(updatedSince).getTime())) {
        return reply.code(400).send({
          error: 'invalid_updated_since',
          message: 'updated_since must be an ISO-8601 timestamp, e.g. 2026-07-01T00:00:00Z',
        });
      }

      const result = products.list({ page, limit, updatedSince });

      addLogNote(
        request,
        `products page=${page} limit=${limit} returned=${result.products.length} total=${result.total}` +
          (updatedSince ? ` updated_since=${updatedSince}` : ''),
      );

      // WeAreDA accepts a bare array or an object wrapping it under
      // data / products / items / results. `products` is the documented default.
      // The extra pagination fields are ignored by WeAreDA and are here purely
      // to make the sandbox easy to inspect by hand.
      return {
        products: result.products,
        page: result.page,
        limit: result.limit,
        total: result.total,
        has_more: result.has_more,
      };
    },
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
