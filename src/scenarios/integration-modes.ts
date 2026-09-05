/**
 * `npm run scenario:integration-modes`
 *
 * The four integration shapes of contract 1.1, each one actually started and
 * actually called.
 *
 *   integrationMode    reads  order delivery  catalog  must implement
 *   ---------------------------------------------------------------------
 *   query_and_send     yes    yes             pull     all four calls
 *   receive_and_send   NO     yes             push     POST /orders + cancel
 *   query_only         yes    NO              pull     GET / + GET /products
 *   receive_only       NO     NO              push     nothing at all
 *
 * Two axes, and they are independent: whether WeAreDA ever READS from you, and
 * whether it ever DELIVERS AN ORDER to you. Inbound webhooks are not an axis -
 * every mode may publish all four event types, given a webhook secret.
 *
 * The sandbox registers only the routes its mode receives, so the 404s below
 * are real: a receive_only reseller genuinely has no read endpoint.
 */
import { buildServer } from '../server.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { inboundAuthHeaders, scenarioBanner, step } from './harness.js';
import {
  INTEGRATION_MODES,
  INTEGRATION_MODE_SHAPES,
  validateAttachBody,
  validateCreateIntegrationBody,
  type CreateIntegrationBody,
  type IntegrationMode,
  type StoredIntegration,
} from '../weareda/integration-mode.js';
import { log } from '../lib/logger.js';

/** Starts a sandbox in one mode on an ephemeral port. */
async function startInMode(base: AppConfig, mode: IntegrationMode) {
  const config: AppConfig = { ...base, integration: { ...base.integration, mode } };
  const sandbox = buildServer(config, { databasePath: ':memory:', quiet: true });
  await sandbox.app.listen({ port: 0, host: '127.0.0.1' });
  const address = sandbox.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { sandbox, config, baseUrl: `http://127.0.0.1:${port}` };
}

async function callAs(baseUrl: string, config: AppConfig, method: 'GET' | 'POST', path: string) {
  const headers = inboundAuthHeaders(config);
  const body =
    method === 'POST'
      ? JSON.stringify({
          order_number: 'ORD-MODE-DEMO',
          idempotency_key: `order:mode-demo-${Date.now()}`,
          items: [{ external_product_id: 'P-1001', quantity: 1 }],
        })
      : undefined;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  await response.text();
  return response.status;
}

async function main(): Promise<void> {
  const base = loadConfig();

  scenarioBanner('SCENARIO: the four integrationModes', [
    'integrationMode is a TOP-LEVEL field of the INTEGRATION body (contract 2.1),',
    'so it is reseller-wide: one value shared by every customer you serve. Not',
    'inside declaredCapabilities, not inside syncConfig, and not in the per-tenant',
    'attach body - orderStatusWrite is the one that lives there.',
    '',
    'Each mode below is started for real and called the way WeAreDA would.',
  ]);

  let index = 0;

  for (const mode of INTEGRATION_MODES) {
    index += 1;
    const shape = INTEGRATION_MODE_SHAPES[mode];
    step(index, `integrationMode: ${mode}`);
    log.plain(shape.summary);
    log.plain('');

    const createBody: CreateIntegrationBody = {
      provider: 'generic_http',
      baseUrl: 'https://example.trycloudflare.com',
      authType: 'api_key',
      credentialScope: 'reseller',
      externalCredentials: { apiKey: 'demo_secret' },
      webhookSecret: 'whsec_example',
      integrationMode: mode,
    };
    const verdict = validateCreateIntegrationBody(createBody);
    log.plain('POST /api/v1/resellers/me/integrations  (integration scope, once):');
    log.plain(JSON.stringify({ ...createBody, externalCredentials: { apiKey: '***' } }, null, 2));
    log.plain('');
    log.plain('WeAreDA answers:');
    log.plain(
      JSON.stringify(
        {
          status: 'connected',
          integrationMode: verdict.mode,
          orderDeliveryEnabled: verdict.orderDeliveryEnabled,
          productsSyncMode: verdict.productsSyncMode,
          effectiveCapabilities: verdict.effectiveCapabilities,
          syncSchedule: shape.reads ? 'daily' : null,
        },
        null,
        2,
      ),
    );
    if (!shape.reads) {
      log.plain('');
      log.plain('No sync schedule is created - and any schedule left by a previous');
      log.plain('mode is deleted. The catalog arrives as product.updated webhooks.');
    }

    log.plain('');
    log.plain('Then, once per customer:');
    log.plain(
      JSON.stringify(
        {
          POST: '/api/v1/resellers/me/tenants/{tenantId}/integration/attach',
          body: { provider: 'generic_http', orderDeliveryStatus: 'confirmed' },
        },
        null,
        2,
      ),
    );

    const { sandbox, config, baseUrl } = await startInMode(base, mode);
    log.plain('');
    log.plain(`Sandbox started in ${mode} mode. What WeAreDA gets when it calls:`);
    for (const [method, path, axis] of [
      ['GET', '/', 'read'],
      ['GET', '/products', 'read'],
      ['POST', '/orders', 'order delivery'],
    ] as const) {
      const status = await callAs(baseUrl, config, method, path);
      const expected = axis === 'read' ? shape.reads : shape.orderDelivery;
      log.plain(
        `  ${method.padEnd(4)} ${path.padEnd(10)} -> ${status}` +
          (expected ? '' : `   not registered in this mode (${axis} disabled)`),
      );
    }
    log.plain('');
    log.plain(
      `POST .../integration/test-connection -> ${
        shape.reads ? '200' : '422 { reason: "read_calls_disabled" }'
      }`,
    );
    if (!shape.reads) {
      log.plain('The connection test IS a read, so there is nothing for it to test.');
    }
    log.plain('');
    log.plain('Publishing webhooks: ALL FOUR event types, in this mode as in every other.');
    log.plain('(product.updated, stock.updated, order.status, invoice.issued)');

    await sandbox.close();
  }

  /* -------------------------------------------------------------------- */
  step(++index, 'What the modes do NOT let you do');

  const createRejections: Array<[string, Record<string, unknown>]> = [
    [
      'a products.mode that contradicts the derived transport',
      { integrationMode: 'query_and_send', syncConfig: { products: { mode: 'push' } } },
    ],
    [
      'integrationMode inside declaredCapabilities',
      { declaredCapabilities: { integrationMode: 'query_only' } },
    ],
    [
      'orderStatusWrite in the INTEGRATION body - it is a per-TENANT setting',
      { orderStatusWrite: true },
    ],
    ['orderStatusWrite inside syncConfig', { syncConfig: { orderStatusWrite: true } }],
  ];

  for (const [title, patch] of createRejections) {
    const verdict = validateCreateIntegrationBody({
      provider: 'generic_http',
      baseUrl: 'https://example.trycloudflare.com',
      externalCredentials: { apiKey: 'demo_secret' },
      ...patch,
    });
    log.plain('');
    log.plain(`${title}:`);
    for (const error of verdict.errors) {
      log.plain(`  ${error.status} ${error.error}`);
      log.plain(`  ${error.message}`);
    }
  }

  const integration: StoredIntegration = {
    provider: 'generic_http',
    integrationMode: 'query_only',
    credentialScope: 'reseller',
  };
  const attachRejections: Array<[string, Record<string, unknown>, StoredIntegration]> = [
    [
      'orderStatusWrite on a mode that never receives an order',
      { orderStatusWrite: true },
      integration,
    ],
    [
      'orderStatusWrite as the STRING "true"',
      { orderStatusWrite: 'true' },
      { ...integration, integrationMode: 'query_and_send' },
    ],
    [
      'baseUrl in the ATTACH body - it would reconfigure every other customer',
      { baseUrl: 'https://other.example.com' },
      { ...integration, integrationMode: 'query_and_send' },
    ],
    [
      'a credential at attach time when the integration holds one per reseller',
      { externalCredentials: { apiKey: 'sk_live_x' } },
      { ...integration, integrationMode: 'query_and_send' },
    ],
  ];

  for (const [title, patch, stored] of attachRejections) {
    const verdict = validateAttachBody({ provider: 'generic_http', ...patch }, stored);
    log.plain('');
    log.plain(`${title}:`);
    for (const error of verdict.errors) {
      log.plain(`  ${error.status} ${error.error}`);
      log.plain(`  ${error.message}`);
    }
  }

  log.plain('');
  log.plain('And the one that is NOT an error - a top-level key WeAreDA does not know:');
  const dropped = validateCreateIntegrationBody({
    provider: 'generic_http',
    baseUrl: 'https://example.trycloudflare.com',
    externalCredentials: { apiKey: 'demo_secret' },
    productsSyncMode: 'push',
  });
  log.plain(`  ok: ${dropped.ok}, silently dropped: ${dropped.ignoredKeys.join(', ')}`);
  log.plain('  productsSyncMode is a RESPONSE field. Sent as input it vanishes without a word.');

  scenarioBanner('SCENARIO COMPLETE', [
    'Two independent axes: reads, and order delivery.',
    '',
    'receive_and_send is NOT "no outbound calls" - orders are still',
    'delivered. Delivering an order is a send, not a query.',
    '',
    'receive_only still requires a baseUrl when you create the',
    'integration. It is registered, not called.',
    '',
    'And the mode lives at INTEGRATION scope while orderStatusWrite lives',
    'at TENANT scope, so a mode change never starts rewriting a',
    'customer-facing column for all of your tenants at once.',
    '',
    'Run one for yourself:',
    '  INTEGRATION_MODE=receive_only npm run dev',
    '  npm run cli -- integration:create --mode receive_only',
    '  npm run cli -- integration:attach',
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
