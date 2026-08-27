/**
 * Integration configuration commands - contract 1.1, 2 and 6.1.
 *
 * Direction: Reseller -> WeAreDA management API (X-Reseller-Key), the same
 * plane as the read API in read-api.ts and a different one from both the
 * inbound connector credentials and the outbound webhook HMAC.
 *
 *   npm run cli -- integration:connect [--mode <mode>] [--order-status-write]
 *   npm run cli -- integration:status
 *   npm run cli -- integration:test
 *
 * The body is validated LOCALLY first, with the same rules and the same error
 * codes WeAreDA applies, so a misplaced field fails here - with an explanation
 * - instead of coming back as a bare 400.
 */
import type { CliContext, ParsedArgs } from '../context.js';
import {
  INTEGRATION_MODES,
  INTEGRATION_MODE_SHAPES,
  isIntegrationMode,
  validateConnectBody,
  type ConnectBody,
  type IntegrationMode,
} from '../../weareda/integration-mode.js';
import { publicBaseUrl } from '../../config/env.js';
import { log, RULE } from '../../lib/logger.js';
import { mask, maskUrl } from '../../lib/redact.js';

const MODE_USAGE = `Modes: ${INTEGRATION_MODES.join(' | ')}`;

/**
 * Builds the connect body this sandbox would register.
 *
 * Note where the two new fields sit: TOP LEVEL, next to orderDeliveryStatus.
 * Not in declaredCapabilities (400 invalid_request), not in syncConfig
 * (400 invalid_sync_config).
 */
export function buildConnectBody(
  ctx: CliContext,
  options: { mode: IntegrationMode; orderStatusWrite: boolean; baseUrl?: string },
): ConnectBody {
  return {
    provider: 'generic_http',
    baseUrl: options.baseUrl ?? publicBaseUrl(ctx.config),
    authType: ctx.config.inbound.mode === 'none' ? 'api_key' : ctx.config.inbound.mode,
    externalCredentials: { apiKey: ctx.config.inbound.apiKey },
    webhookSecret: ctx.config.webhook.secret,
    orderDeliveryStatus: 'confirmed',
    integrationMode: options.mode,
    orderStatusWrite: options.orderStatusWrite,
    // Metadata only: it documents what we support and enables nothing. The
    // effective capabilities are connector support n platform ceiling n mode.
    declaredCapabilities: {
      productsRead: true,
      stockRead: true,
      stockWebhooks: true,
      ordersWrite: true,
      invoices: true,
    },
    // No products.mode here: the catalog transport is DERIVED from
    // integrationMode, and contradicting it is a 400.
    syncConfig: { frequency: 'daily' },
  };
}

export async function integrationConnectCommand(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<number> {
  const requested = args.flags.mode ?? args.positionals[0] ?? ctx.config.integration.mode;
  if (!isIntegrationMode(requested)) {
    log.plain(`Usage: npm run cli -- integration:connect [--mode <mode>] [--order-status-write]`);
    log.plain('');
    log.plain(MODE_USAGE);
    return 1;
  }
  const mode = requested;
  const orderStatusWrite =
    args.flags['order-status-write'] === true
      ? true
      : args.flags['order-status-write'] === 'false'
        ? false
        : ctx.config.integration.orderStatusWrite;

  const body = buildConnectBody(ctx, {
    mode,
    orderStatusWrite,
    baseUrl: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : undefined,
  });

  const shape = INTEGRATION_MODE_SHAPES[mode];

  log.plain(RULE);
  log.plain('INTEGRATION CONNECT');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain(`integrationMode:  ${mode}`);
  log.plain(`  reads:          ${shape.reads ? 'yes - GET / and GET /products' : 'no'}`);
  log.plain(
    `  order delivery: ${shape.orderDelivery ? 'yes - POST /orders and .../cancel' : 'no'}`,
  );
  log.plain(`  catalog:        ${shape.productsSyncMode}`);
  log.plain(`orderStatusWrite: ${orderStatusWrite}`);
  log.plain('');
  log.plain('Body (both new fields are TOP LEVEL, siblings of orderDeliveryStatus):');
  log.plain(JSON.stringify({ ...body, externalCredentials: { apiKey: '***' } }, null, 2));

  /* ---- local validation, with WeAreDA's own rules --------------------- */
  const verdict = validateConnectBody(body);
  if (verdict.ignoredKeys.length > 0) {
    log.plain('');
    log.warn(
      `WeAreDA silently DROPS unknown top-level keys: ${verdict.ignoredKeys.join(', ')}. ` +
        'They will not appear in the response and no error is returned.',
    );
  }
  if (!verdict.ok) {
    log.plain('');
    log.plain('Rejected locally - WeAreDA would answer:');
    for (const error of verdict.errors) {
      log.plain(`  ${error.status} ${error.error}: ${error.message}`);
    }
    log.plain(RULE);
    return 1;
  }

  log.plain('');
  log.plain('Would take effect:');
  log.plain(`  integrationMode       ${verdict.mode}`);
  log.plain(`  orderDeliveryEnabled  ${verdict.orderDeliveryEnabled}`);
  log.plain(`  productsSyncMode      ${verdict.productsSyncMode}   (derived, never an input)`);
  log.plain(`  orderStatusWrite      ${verdict.orderStatusWrite}`);
  log.plain(`  effectiveCapabilities ${JSON.stringify(verdict.effectiveCapabilities)}`);

  if (!ctx.readApi.configured || args.flags['dry-run'] === true) {
    log.plain('');
    log.plain('DRY RUN - not sent.');
    log.plain(
      'Set WEAREDA_API_BASE_URL, WEAREDA_RESELLER_KEY and WEAREDA_TENANT_ID to register for real',
    );
    log.plain('(`npm run mock:weareda` serves this endpoint locally).');
    log.plain(RULE);
    return 0;
  }

  return send(ctx, () => ctx.readApi.connect(body));
}

export async function integrationStatusCommand(ctx: CliContext): Promise<number> {
  log.plain(RULE);
  log.plain('INTEGRATION STATUS');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain('Echoes integrationMode, orderDeliveryEnabled and productsSyncMode.');
  return send(ctx, () => ctx.readApi.integrationStatus());
}

export async function integrationTestCommand(ctx: CliContext): Promise<number> {
  log.plain(RULE);
  log.plain('INTEGRATION TEST-CONNECTION');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain('Asks WeAreDA to call GET / on our baseUrl.');
  log.plain('The connection test IS a read: in receive_and_send / receive_only this');
  log.plain('answers 422 { reason: "read_calls_disabled" } without calling anything.');
  return send(ctx, () => ctx.readApi.testConnection());
}

async function send(
  ctx: CliContext,
  call: () => Promise<{
    method: string;
    url: string;
    statusCode: number;
    statusText: string;
    ok: boolean;
    body: unknown;
  }>,
): Promise<number> {
  log.plain('');
  log.plain('Authentication:');
  log.plain(`X-Reseller-Key: ${mask(ctx.config.managementApi.resellerKey)}`);
  log.plain(`Tenant: ${ctx.config.managementApi.tenantId || '(WEAREDA_TENANT_ID not set)'}`);

  try {
    const response = await call();
    log.plain('');
    log.plain(`${response.method} ${maskUrl(response.url)}`);
    log.plain('');
    log.plain('Response:');
    log.plain(`${response.statusCode} ${response.statusText}`);
    log.plain(JSON.stringify(response.body, null, 2));
    log.plain(RULE);
    return response.ok ? 0 : 1;
  } catch (error) {
    log.plain('');
    log.plain(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    log.plain(RULE);
    return 1;
  }
}
