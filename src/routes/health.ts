/**
 * GET / - test connection (contract 4.1)
 *
 * Direction: WeAreDA -> Reseller.
 *
 * WeAreDA calls your base URL with the registered credentials to verify them.
 * Any 2xx satisfies the contract - the body is ignored. 401/403 means
 * "credentials rejected"; 5xx or a timeout is retryable.
 *
 * THE CONNECTION TEST IS A READ. In an integrationMode without reads
 * (receive_and_send, receive_only) WeAreDA never calls it, so this sandbox does
 * not register it, and `POST .../integration/test-connection` answers
 * `422 { reason: "read_calls_disabled" }` instead of testing anything.
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { isoTimestamp } from '../lib/ids.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  options: { connectionTest: boolean } = { connectionTest: true },
): void {
  if (options.connectionTest) {
    app.get('/', { preHandler: requireAuth(config) }, async () => ({
      ok: true,
      service: 'weareda-reseller-reference',
      timestamp: isoTimestamp(),
    }));
  }

  // Unauthenticated liveness probe for Docker / load balancers. This is NOT the
  // contract's connection test - WeAreDA always calls `GET /` with credentials.
  app.get('/healthz', async () => ({ ok: true }));
}
