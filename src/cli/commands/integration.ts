/**
 * Integration configuration commands - contract 1.1, 2, 6.1 and 7.1.
 *
 * Direction: Reseller -> WeAreDA management API (X-Reseller-Key), the same
 * plane as the read API in read-api.ts and a different one from both the
 * inbound connector credentials and the outbound webhook HMAC.
 *
 * TWO SCOPES, TWO CALLS (contract 2):
 *
 *   npm run cli -- integration:create [--mode <mode>] [--credential-scope ...]
 *                                     [--requires-tax-id] [--base-url ...]
 *   npm run cli -- integration:attach [--order-status-write]
 *                                     [--external-tenant-id cust-7]
 *
 * The first is reseller-wide and is run ONCE. The second is per customer, and
 * cannot reach anything the first configured.
 *
 *   npm run cli -- integration:list
 *   npm run cli -- integration:get
 *   npm run cli -- integration:patch [--mode m] [--frequency daily]
 *                                    [--document-hosts a,b] [--sync-config '{…}']
 *   npm run cli -- integration:rotate-credentials [--api-key ...]
 *   npm run cli -- integration:rotate-secret [--secret ...]
 *   npm run cli -- integration:disconnect
 *   npm run cli -- integration:status
 *   npm run cli -- integration:test
 *
 * Every body is validated LOCALLY first, with the same rules and the same
 * error codes WeAreDA applies, so a misplaced field fails here - with an
 * explanation of which scope it belongs to - instead of coming back as a bare
 * 400.
 */
import type { CliContext, ParsedArgs } from '../context.js';
import {
  CREDENTIAL_SCOPES,
  INTEGRATION_MODES,
  INTEGRATION_MODE_SHAPES,
  REMOVED_CONNECT_ENDPOINT,
  isCredentialScope,
  isIntegrationMode,
  validateAttachBody,
  validateCreateIntegrationBody,
  validatePatchIntegrationBody,
  type AttachTenantBody,
  type CreateIntegrationBody,
  type CredentialScope,
  type IntegrationMode,
  type PatchIntegrationBody,
  type StoredIntegration,
  type SyncConfigPatch,
  type ValidationError,
} from '../../weareda/integration-mode.js';
import { publicBaseUrl } from '../../config/env.js';
import { log, RULE } from '../../lib/logger.js';
import { mask, maskUrl } from '../../lib/redact.js';

const MODE_USAGE = `Modes: ${INTEGRATION_MODES.join(' | ')}`;

/* -------------------------------------------------------------------------- */
/* 2.1 - create the integration (once, reseller-wide)                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the INTEGRATION body (contract 2.1).
 *
 * Note what is NOT here: orderDeliveryStatus, orderStatusWrite and
 * externalTenantId. Those are per customer and belong to the attach body -
 * sending one here is a 400 that says so.
 */
export function buildCreateIntegrationBody(
  ctx: CliContext,
  options: {
    mode: IntegrationMode;
    credentialScope: CredentialScope;
    /** Contract 4.3.2 - default false, and false is what most resellers want. */
    requiresTaxId?: boolean;
    baseUrl?: string;
  },
): CreateIntegrationBody {
  const body: CreateIntegrationBody = {
    provider: ctx.config.integration.provider,
    baseUrl: options.baseUrl ?? publicBaseUrl(ctx.config),
    authType: ctx.config.inbound.mode === 'none' ? 'api_key' : ctx.config.inbound.mode,
    credentialScope: options.credentialScope,
    webhookSecret: ctx.config.webhook.secret,
    integrationMode: options.mode,
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
    //
    // requiresTaxId, unlike orderStatusWrite, IS a syncConfig option (contract
    // 7): it configures WeAreDA's delivery eligibility rule, not the shape of
    // the integration - and it is reseller-wide, like the rest of syncConfig.
    syncConfig: {
      frequency: 'daily',
      orders: { requiresTaxId: options.requiresTaxId ?? false },
    },
  };

  // At tenant scope the credential comes with each attach: there is no
  // customer yet to own one here, and sending it anyway is a 400.
  if (options.credentialScope === 'reseller') {
    body.externalCredentials = { apiKey: ctx.config.inbound.apiKey };
  }
  return body;
}

export async function integrationCreateCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const requested = args.flags.mode ?? args.positionals[0] ?? ctx.config.integration.mode;
  if (!isIntegrationMode(requested)) {
    log.plain(
      'Usage: npm run cli -- integration:create [--mode <mode>] ' +
        '[--credential-scope reseller|tenant] [--requires-tax-id] [--base-url ...]',
    );
    log.plain('');
    log.plain(MODE_USAGE);
    return 1;
  }
  const mode = requested;

  const scopeFlag = args.flags['credential-scope'] ?? ctx.config.integration.credentialScope;
  if (!isCredentialScope(scopeFlag)) {
    log.plain(`--credential-scope must be one of: ${CREDENTIAL_SCOPES.join(' | ')}`);
    return 1;
  }

  const requiresTaxId = args.flags['requires-tax-id'] === true;
  const body = buildCreateIntegrationBody(ctx, {
    mode,
    credentialScope: scopeFlag,
    requiresTaxId,
    baseUrl: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : undefined,
  });

  const shape = INTEGRATION_MODE_SHAPES[mode];

  log.plain(RULE);
  log.plain('CREATE INTEGRATION   POST /api/v1/resellers/me/integrations');
  log.plain('Scope: INTEGRATION - one per (reseller, provider), shared by EVERY tenant');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain(`integrationMode:  ${mode}`);
  log.plain(`  reads:          ${shape.reads ? 'yes - GET / and GET /products' : 'no'}`);
  log.plain(
    `  order delivery: ${shape.orderDelivery ? 'yes - POST /orders and .../cancel' : 'no'}`,
  );
  log.plain(`  catalog:        ${shape.productsSyncMode}`);
  log.plain(`credentialScope:  ${scopeFlag}`);
  log.plain(
    scopeFlag === 'reseller'
      ? '  One credential for every customer. Rotate it with integration:rotate-credentials.'
      : '  One credential per customer: it is NOT sent here, it comes with each attach.',
  );
  log.plain(`syncConfig.orders.requiresTaxId: ${requiresTaxId}`);
  log.plain(
    requiresTaxId
      ? '  An order whose customer has no fiscal id is NOT delivered. It becomes\n' +
          '  eligible and arrives automatically, within a minute, once the tenant\n' +
          '  completes the contact - nothing is parked and nothing is re-queued (4.3.2).'
      : '  The default. Orders arrive whether or not the customer has a fiscal id,\n' +
          '  and customer.tax_id is null when they do not. If you cannot invoice\n' +
          '  without one, set this flag - do NOT reject the order on arrival (4.3.2).',
  );
  log.plain('');
  log.plain('Body (integration scope only - no per-tenant field belongs here):');
  log.plain(JSON.stringify(redactBody(body), null, 2));

  const verdict = validateCreateIntegrationBody(body);
  if (!report(verdict.errors, verdict.ignoredKeys)) return 1;

  log.plain('');
  log.plain('Would take effect:');
  log.plain(`  integrationMode       ${verdict.mode}`);
  log.plain(`  credentialScope       ${verdict.credentialScope}`);
  log.plain(`  orderDeliveryEnabled  ${verdict.orderDeliveryEnabled}`);
  log.plain(`  productsSyncMode      ${verdict.productsSyncMode}   (derived, never an input)`);
  log.plain(`  effectiveCapabilities ${JSON.stringify(verdict.effectiveCapabilities)}`);
  log.plain('');
  log.plain('A second create for this provider answers 409 integration_exists - it is a');
  log.plain('create, not an upsert. Change it with integration:patch.');
  log.plain('');
  log.plain('Then attach each customer:  npm run cli -- integration:attach');

  if (dryRun(ctx, args)) return 0;
  return send(ctx, () => ctx.readApi.createIntegration(body));
}

/* -------------------------------------------------------------------------- */
/* 2.2 - attach a customer (per tenant)                                        */
/* -------------------------------------------------------------------------- */

/** Builds the TENANT body (contract 2.2). Nothing here is reseller-wide. */
export function buildAttachBody(
  ctx: CliContext,
  options: {
    orderStatusWrite: boolean;
    orderDeliveryStatus?: string;
    externalTenantId?: string;
    credentialScope?: CredentialScope;
  },
): AttachTenantBody {
  const body: AttachTenantBody = {
    provider: ctx.config.integration.provider,
    orderDeliveryStatus: options.orderDeliveryStatus ?? 'confirmed',
    orderStatusWrite: options.orderStatusWrite,
  };
  const externalTenantId = options.externalTenantId ?? ctx.config.integration.externalTenantId;
  if (externalTenantId) body.externalTenantId = externalTenantId;
  // Only at credentialScope 'tenant' - at reseller scope this same key is a 400.
  if (options.credentialScope === 'tenant') {
    body.externalCredentials = { apiKey: ctx.config.inbound.apiKey };
  }
  return body;
}

export async function integrationAttachCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const orderStatusWrite =
    args.flags['order-status-write'] === true
      ? true
      : args.flags['order-status-write'] === 'false'
        ? false
        : ctx.config.integration.orderStatusWrite;

  const credentialScope = isCredentialScope(args.flags['credential-scope'])
    ? args.flags['credential-scope']
    : ctx.config.integration.credentialScope;

  const body = buildAttachBody(ctx, {
    orderStatusWrite,
    credentialScope,
    orderDeliveryStatus:
      typeof args.flags['order-delivery-status'] === 'string'
        ? args.flags['order-delivery-status']
        : undefined,
    externalTenantId:
      typeof args.flags['external-tenant-id'] === 'string'
        ? args.flags['external-tenant-id']
        : undefined,
  });

  log.plain(RULE);
  log.plain('ATTACH CUSTOMER      POST .../tenants/{tenantId}/integration/attach');
  log.plain('Scope: TENANT - this one customer, and no other');
  log.plain('Direction: Reseller -> WeAreDA management API');
  log.plain('');
  log.plain(`orderStatusWrite: ${orderStatusWrite}`);
  log.plain(
    orderStatusWrite
      ? '  Your order.status events also move the CUSTOMER-FACING order status,\n' +
          '  along a ladder that only ever advances (6.1). It is per TENANT on\n' +
          '  purpose: a mode change must never start rewriting a column the\n' +
          "  tenant's staff edit, for all of your customers at once."
      : '  The default. Your order.status events move integration_status only.',
  );
  log.plain('');
  log.plain('Body (tenant scope only):');
  log.plain(JSON.stringify(redactBody(body), null, 2));

  // Validated against the integration this customer is being attached to: the
  // mode lives there, and orderStatusWrite depends on it.
  const integration: StoredIntegration = {
    provider: ctx.config.integration.provider,
    integrationMode: ctx.config.integration.mode,
    credentialScope,
  };
  const verdict = validateAttachBody(body, integration);
  if (!report(verdict.errors, verdict.ignoredKeys)) return 1;

  log.plain('');
  log.plain('Would take effect for this customer:');
  log.plain(`  orderStatusWrite      ${verdict.orderStatusWrite}`);
  log.plain(`  orderDeliveryStatus   ${verdict.orderDeliveryStatus}`);
  log.plain(`  externalTenantId      ${verdict.externalTenantId ?? '(none)'}`);
  log.plain(`  integrationMode       ${verdict.mode}   (from the integration, not from here)`);
  log.plain(`  effectiveCapabilities ${JSON.stringify(verdict.effectiveCapabilities)}`);
  log.plain('');
  log.plain("The response carries THIS customer's webhookUrl.");

  if (dryRun(ctx, args)) return 0;
  return send(ctx, () => ctx.readApi.attachTenant(body));
}

/* -------------------------------------------------------------------------- */
/* 2.3 - read and change the integration                                       */
/* -------------------------------------------------------------------------- */

export async function integrationListCommand(ctx: CliContext): Promise<number> {
  log.plain(RULE);
  log.plain('LIST INTEGRATIONS    GET /api/v1/resellers/me/integrations');
  log.plain('');
  log.plain('Each one comes back with the customers attached to it.');
  return send(ctx, () => ctx.readApi.listIntegrations());
}

export async function integrationGetCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const provider = providerOf(ctx, args);
  log.plain(RULE);
  log.plain(`GET INTEGRATION      GET /api/v1/resellers/me/integrations/${provider}`);
  log.plain('');
  log.plain('Read the stored syncConfig from here before you PATCH it: a named');
  log.plain('section is REPLACED whole, not deep-merged (7.1).');
  return send(ctx, () => ctx.readApi.getIntegration(provider));
}

export async function integrationPatchCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const provider = providerOf(ctx, args);
  const body: PatchIntegrationBody = {};

  if (args.flags.mode !== undefined) {
    if (!isIntegrationMode(args.flags.mode)) {
      log.plain(MODE_USAGE);
      return 1;
    }
    body.integrationMode = args.flags.mode;
  }
  if (typeof args.flags['base-url'] === 'string') body.baseUrl = args.flags['base-url'];
  if (args.flags['credential-scope'] !== undefined) {
    if (!isCredentialScope(args.flags['credential-scope'])) {
      log.plain(`--credential-scope must be one of: ${CREDENTIAL_SCOPES.join(' | ')}`);
      return 1;
    }
    body.credentialScope = args.flags['credential-scope'];
  }

  const syncConfig: SyncConfigPatch = {};
  if (typeof args.flags['sync-config'] === 'string') {
    try {
      Object.assign(syncConfig, JSON.parse(args.flags['sync-config']) as SyncConfigPatch);
    } catch (error) {
      log.error(`--sync-config is not valid JSON: ${String(error)}`);
      return 1;
    }
  }
  if (typeof args.flags.frequency === 'string') {
    syncConfig.frequency = args.flags.frequency as 'hourly' | 'daily' | 'weekly';
  }
  if (typeof args.flags['document-hosts'] === 'string') {
    syncConfig.documentHosts = args.flags['document-hosts'].split(',').map((host) => host.trim());
  }
  if (Object.keys(syncConfig).length > 0) body.syncConfig = syncConfig;

  if (Object.keys(body).length === 0) {
    log.plain(
      'Usage: npm run cli -- integration:patch [--mode <mode>] [--base-url ...] ' +
        "[--frequency daily] [--document-hosts a,b] [--sync-config '{…}']",
    );
    return 1;
  }

  log.plain(RULE);
  log.plain(`PATCH INTEGRATION    PATCH /api/v1/resellers/me/integrations/${provider}`);
  log.plain('Scope: INTEGRATION - this changes EVERY tenant of yours');
  log.plain('');
  log.plain('Body (partial - an omitted field is left alone):');
  log.plain(JSON.stringify(body, null, 2));
  log.plain('');
  log.plain('syncConfig merge (7.1): only the top-level keys you name are touched, a');
  log.plain('named section REPLACES the stored one whole, and null deletes a key.');
  log.plain('Credentials and the webhook secret are not patchable - they have their own PUT.');

  // The stored syncConfig lives on the WeAreDA side, so the local check runs
  // against an empty one: it still catches a malformed patch before the trip.
  const verdict = validatePatchIntegrationBody(body, {
    provider,
    integrationMode: ctx.config.integration.mode,
    credentialScope: ctx.config.integration.credentialScope,
  });
  if (!report(verdict.errors, verdict.ignoredKeys)) return 1;

  log.plain('');
  log.plain(
    `Resulting integrationMode: ${verdict.mode} (productsSyncMode ${verdict.productsSyncMode})`,
  );
  log.plain('The response reports affectedTenants and schedulesReconciled.');

  if (dryRun(ctx, args)) return 0;
  return send(ctx, () => ctx.readApi.patchIntegration(provider, body));
}

export async function integrationRotateCredentialsCommand(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<number> {
  const provider = providerOf(ctx, args);
  const apiKey =
    typeof args.flags['api-key'] === 'string' ? args.flags['api-key'] : ctx.config.inbound.apiKey;

  log.plain(RULE);
  log.plain(`ROTATE CREDENTIALS   PUT /api/v1/resellers/me/integrations/${provider}/credentials`);
  log.plain('');
  log.plain('Rotation is never a side effect of an edit: this is the only call that');
  log.plain('changes the credential WeAreDA authenticates to you with.');
  log.plain(`New credential: ${mask(apiKey)}`);

  if (dryRun(ctx, args)) return 0;
  return send(ctx, () => ctx.readApi.rotateCredentials(provider, { apiKey }));
}

export async function integrationRotateSecretCommand(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<number> {
  const provider = providerOf(ctx, args);
  const secret =
    typeof args.flags.secret === 'string' ? args.flags.secret : ctx.config.webhook.secret;

  log.plain(RULE);
  log.plain(
    `ROTATE WEBHOOK SECRET PUT /api/v1/resellers/me/integrations/${provider}/webhook-secret`,
  );
  log.plain('');
  log.plain('One signing secret per reseller, so this applies to EVERY webhook you send');
  log.plain('us. Sign the next event with the new value (contract 3.2, 9).');
  log.plain(`New secret: ${mask(secret)}`);

  if (dryRun(ctx, args)) return 0;
  return send(ctx, () => ctx.readApi.rotateWebhookSecret(provider, secret));
}

export async function integrationDisconnectCommand(ctx: CliContext): Promise<number> {
  log.plain(RULE);
  log.plain('DISCONNECT CUSTOMER  POST .../tenants/{tenantId}/integration/disconnect');
  log.plain('');
  log.plain('Detaches THIS customer. Your integration, and every other customer on it,');
  log.plain('is untouched.');
  return send(ctx, () => ctx.readApi.disconnectTenant());
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

export async function integrationRetryCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const operationId = args.positionals[0];
  if (!operationId) {
    log.plain('Usage: npm run cli -- integration:retry <operationId>');
    return 1;
  }
  log.plain(RULE);
  log.plain('RETRY OPERATION      POST .../integration/operations/{operationId}/retry');
  log.plain('');
  log.plain('The documented use (7.1): an invoice.issued whose document_url was not on');
  log.plain('the documentHosts allow-list. Widen it with integration:patch, then retry -');
  log.plain('the invoice header is upserted idempotently, so this only fills in the PDF.');
  return send(ctx, () => ctx.readApi.retryOperation(operationId));
}

/**
 * The removed endpoint (contract 2.3, 9). Kept as a command purely so that
 * anyone running the old one is told what to run instead, instead of getting
 * "Unknown command".
 */
export async function integrationConnectCommand(): Promise<number> {
  log.plain(RULE);
  log.plain(`${REMOVED_CONNECT_ENDPOINT.status} ${REMOVED_CONNECT_ENDPOINT.error}`);
  log.plain('');
  log.plain(REMOVED_CONNECT_ENDPOINT.path);
  log.plain('');
  log.plain(REMOVED_CONNECT_ENDPOINT.message);
  log.plain('');
  log.plain('Replacements:');
  for (const replacement of REMOVED_CONNECT_ENDPOINT.replacements) {
    log.plain(`  ${replacement}`);
  }
  log.plain('');
  log.plain('In this CLI:');
  log.plain('  npm run cli -- integration:create --mode query_and_send');
  log.plain('  npm run cli -- integration:attach --order-status-write');
  log.plain(RULE);
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function providerOf(ctx: CliContext, args: ParsedArgs): string {
  return typeof args.flags.provider === 'string'
    ? args.flags.provider
    : ctx.config.integration.provider;
}

function redactBody<T extends { externalCredentials?: Record<string, string> }>(body: T): T {
  return body.externalCredentials ? { ...body, externalCredentials: { apiKey: '***' } } : body;
}

function dryRun(ctx: CliContext, args: ParsedArgs): boolean {
  if (ctx.readApi.configured && args.flags['dry-run'] !== true) return false;
  log.plain('');
  log.plain('DRY RUN - not sent.');
  log.plain(
    'Set WEAREDA_API_BASE_URL, WEAREDA_RESELLER_KEY and WEAREDA_TENANT_ID to register for real',
  );
  log.plain('(`npm run mock:weareda` serves these endpoints locally).');
  log.plain(RULE);
  return true;
}

/** Prints what WeAreDA would answer. Returns false when the body is rejected. */
function report(errors: ValidationError[], ignoredKeys: string[]): boolean {
  if (ignoredKeys.length > 0) {
    log.plain('');
    log.warn(
      `WeAreDA silently DROPS unknown top-level keys: ${ignoredKeys.join(', ')}. ` +
        'They will not appear in the response and no error is returned.',
    );
  }
  if (errors.length === 0) return true;
  log.plain('');
  log.plain('Rejected locally - WeAreDA would answer:');
  for (const error of errors) {
    log.plain(`  ${error.status} ${error.error}: ${error.message}`);
  }
  log.plain(RULE);
  return false;
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
