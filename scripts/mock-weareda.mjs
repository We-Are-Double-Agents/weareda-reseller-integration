#!/usr/bin/env node
/**
 * A stand-in for the WeAreDA side of the integration, for local testing.
 *
 *   npm run mock:weareda
 *
 * Then, in .env:
 *   WEAREDA_WEBHOOK_URL=http://localhost:4000/api/v1/reseller-webhooks/demo-connection
 *   WEAREDA_WEBHOOK_SECRET=whsec_example
 *   WEAREDA_API_BASE_URL=http://localhost:4000
 *   WEAREDA_RESELLER_KEY=rsk_example
 *   WEAREDA_TENANT_ID=tenant_demo
 *
 * and your CLI, scenarios and Postman requests stop being dry runs.
 *
 * This is NOT WeAreDA. It is a faithful-enough imitation of the parts of the
 * contract you need to see for yourself:
 *
 *   POST /api/v1/reseller-webhooks/{connectionId}          section 6
 *     202 { accepted: true, operationId }    queued
 *     200 { deduped: true, operationId }     duplicate event id
 *     400 { error: 'unsupported_event' }     unknown/missing top-level type
 *     400 { error: 'multiple_event_types' }  two types, or a batch envelope
 *     400 { error: 'too_many_items', max }   product.updated over 500
 *     401 { error: 'unauthorized' }          bad signature or no secret
 *     401 { error: 'stale_timestamp' }       outside the +/-5 minute window
 *     404 { error: 'not_found' }             unknown connection
 *
 *   The configuration plane, in its TWO SCOPES (section 2):
 *
 *   POST  /api/v1/resellers/me/integrations                              s.2.1
 *     201 the integration      409 { error: 'integration_exists' }
 *   GET   /api/v1/resellers/me/integrations                              s.2.3
 *   GET   /api/v1/resellers/me/integrations/{provider}                   s.2.3
 *   PATCH /api/v1/resellers/me/integrations/{provider}                   s.2.3/7.1
 *     merges syncConfig by 7.1, echoes affectedTenants/schedulesReconciled,
 *     409 { error: 'order_status_write_conflict' } when it would strand a tenant
 *   PUT   /api/v1/resellers/me/integrations/{provider}/credentials       s.2.3
 *   PUT   /api/v1/resellers/me/integrations/{provider}/webhook-secret    s.2.3
 *
 *   POST  /api/v1/resellers/me/tenants/{tenantId}/integration/attach     s.2.2
 *   PATCH /api/v1/resellers/me/tenants/{tenantId}/integration            s.2.2
 *   POST  /api/v1/resellers/me/tenants/{tenantId}/integration/disconnect s.2.2
 *   GET   /api/v1/resellers/me/tenants/{tenantId}/integration/status     s.1.1/2
 *   POST  /api/v1/resellers/me/tenants/{tenantId}/integration/test-connection s.1.1
 *   POST  /api/v1/resellers/me/tenants/{tenantId}/integration/connect
 *     410 { error: 'endpoint_removed' }   the one breaking change (s.2.3, 9)
 *     authenticated with X-Reseller-Key, NOT with the webhook HMAC.
 *
 *   POST /api/v1/mock/orders        seed an order "WeAreDA delivered to you"
 *   GET  /api/v1/mock/orders        inspect orders and both status columns
 *   GET  /api/v1/mock/operations    inspect integration_operations results
 *   (the /api/v1/mock/* namespace is a local aid; it is not in the contract)
 *
 * Like the real endpoint it verifies the HMAC over the RAW body bytes, and
 * processing is asynchronous in the sense that 202 means "queued".
 *
 * The rules below are deliberately duplicated from src/weareda/ rather than
 * imported: this script stands in for the OTHER side of the integration, and
 * sharing code with the reseller implementation would make it prove less.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID, createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const SECRET = process.env.WEAREDA_WEBHOOK_SECRET || 'whsec_example';
const RESELLER_KEY = process.env.WEAREDA_RESELLER_KEY || 'rsk_example';
const REPLAY_WINDOW_SECONDS = 300;
const MAX_PRODUCTS = 500;
const MAX_BYTES = 512 * 1024;

const seenEventIds = new Map(); // `${connection}:${type}:${id}` -> operationId
// TWO SCOPES (contract 2), stored as two maps on purpose: the bug the removed
// `connect` had was writing the first one from a tenant-scoped URL.
const integrations = new Map(); // provider -> reseller-wide integration
const connections = new Map(); // tenantId  -> per-customer connection
const orders = new Map(); // reference -> order row
const operations = []; // integration_operations, newest last
const RULE = '-'.repeat(50);

/* ========================================================================== */
/* Contract 1.1 - integrationMode                                             */
/* ========================================================================== */

const INTEGRATION_MODES = ['query_and_send', 'receive_and_send', 'query_only', 'receive_only'];

/** reads = GET / and GET /products. orderDelivery = POST /orders and cancel. */
const MODE_SHAPES = {
  query_and_send: { reads: true, orderDelivery: true, productsSyncMode: 'pull' },
  receive_and_send: { reads: false, orderDelivery: true, productsSyncMode: 'push' },
  query_only: { reads: true, orderDelivery: false, productsSyncMode: 'pull' },
  receive_only: { reads: false, orderDelivery: false, productsSyncMode: 'push' },
};

const CAPABILITY_KEYS = [
  'productsRead',
  'productsWrite',
  'stockRead',
  'stockWebhooks',
  'ordersWrite',
  'invoices',
];

const CONNECTOR_SUPPORT = {
  productsRead: true,
  productsWrite: false,
  stockRead: true,
  stockWebhooks: true,
  ordersWrite: true,
  invoices: true,
};

const SYNC_CONFIG_KEYS = [
  'products',
  'orders',
  'documentHosts',
  'enabled',
  'frequency',
  'scheduleExpression',
];
const SYNC_PRODUCTS_KEYS = [
  'mode',
  'path',
  'pageParam',
  'pageSizeParam',
  'sinceParam',
  'pageSize',
  'itemsKey',
  'fieldMap',
];
const SYNC_ORDERS_KEYS = ['path', 'idempotencyHeader', 'orderIdField', 'requiresTaxId'];

/** connector support n platform ceiling n mode. The declaration is not an input. */
function effectiveCapabilities(mode) {
  const delivers = MODE_SHAPES[mode].orderDelivery;
  const result = {};
  for (const key of CAPABILITY_KEYS) {
    result[key] = CONNECTOR_SUPPORT[key] && (key === 'ordersWrite' ? delivers : true);
  }
  return result;
}

/** Shared syncConfig whitelist (contract 7). Unknown options are rejected. */
function validateSyncConfig(sync, mode, bad) {
  if (sync === undefined) return;
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) {
    bad('invalid_sync_config', 'syncConfig must be an object.');
    return;
  }
  for (const key of Object.keys(sync)) {
    if (!SYNC_CONFIG_KEYS.includes(key)) {
      bad(
        'invalid_sync_config',
        `syncConfig.${key} is not a known option.` +
          (key === 'integrationMode'
            ? ' integrationMode is a TOP-LEVEL field of the integration body.'
            : key === 'orderStatusWrite'
              ? ' orderStatusWrite is a TENANT field - it belongs to the attach body.'
              : ''),
      );
    }
  }
  for (const key of Object.keys(sync.products ?? {})) {
    if (!SYNC_PRODUCTS_KEYS.includes(key)) {
      bad('invalid_sync_config', `syncConfig.products.${key} is not a known option.`);
    }
  }
  for (const key of Object.keys(sync.orders ?? {})) {
    if (!SYNC_ORDERS_KEYS.includes(key)) {
      bad('invalid_sync_config', `syncConfig.orders.${key} is not a known option.`);
    }
  }
  if (sync.orders?.requiresTaxId !== undefined && typeof sync.orders.requiresTaxId !== 'boolean') {
    bad('invalid_sync_config', 'syncConfig.orders.requiresTaxId must be a boolean.');
  }
  for (const host of sync.documentHosts ?? []) {
    // Bare hostnames only: never a URL, port, path, or IP literal (7, 9).
    if (
      typeof host !== 'string' ||
      /[/:@]/.test(host) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      !host.includes('.')
    ) {
      bad(
        'invalid_sync_config',
        `syncConfig.documentHosts ${JSON.stringify(host)} must be a BARE hostname.`,
      );
    }
  }
  const derived = MODE_SHAPES[mode].productsSyncMode;
  const requestedProductsMode = sync.products?.mode;
  if (
    (requestedProductsMode === 'pull' || requestedProductsMode === 'push') &&
    requestedProductsMode !== derived
  ) {
    bad(
      'invalid_sync_config',
      `syncConfig.products.mode "${requestedProductsMode}" contradicts integrationMode "${mode}", ` +
        `which derives "${derived}". This is a 400, not a precedence rule.`,
    );
  }
}

/** Contract 7.1 - named top-level keys replace whole; null deletes. */
function mergeSyncConfig(current = {}, patch) {
  if (patch === undefined) return { ...current };
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Fields that belong to the OTHER scope, and where each one goes (contract 2). */
const INTEGRATION_SCOPE_FIELDS = {
  baseUrl: 'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  authType: 'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  credentialScope: 'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  integrationMode: 'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  declaredCapabilities:
    'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  syncConfig: 'POST /api/v1/resellers/me/integrations (or PATCH /integrations/{provider})',
  webhookSecret: 'PUT /integrations/{provider}/webhook-secret',
};
const TENANT_SCOPE_FIELDS = {
  orderDeliveryStatus: 'POST .../tenants/{tenantId}/integration/attach',
  orderStatusWrite: 'POST .../tenants/{tenantId}/integration/attach',
  externalTenantId: 'POST .../tenants/{tenantId}/integration/attach',
};

const KNOWN_CREATE_KEYS = [
  'provider',
  'baseUrl',
  'authType',
  'credentialScope',
  'externalCredentials',
  'webhookSecret',
  'integrationMode',
  'declaredCapabilities',
  'syncConfig',
];

/**
 * Validates POST /api/v1/resellers/me/integrations (contract 2.1).
 *
 * Unknown keys INSIDE syncConfig are rejected loudly; unknown keys at the TOP
 * LEVEL of the body are dropped in silence - `productsSyncMode` among them,
 * because it is a response field.
 */
function validateCreate(rawBody, existing) {
  const errors = [];
  const bad = (error, message) => errors.push({ error, message });
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  if (body !== rawBody) bad('invalid_request', 'The body must be a JSON object.');

  if (existing) {
    bad(
      'integration_exists',
      `An integration already exists for provider "${existing.provider}". This is a create, ` +
        'not an upsert: use PATCH /integrations/{provider}.',
    );
  }
  if (typeof body.provider !== 'string' || body.provider === '') {
    bad('invalid_request', 'provider is required.');
  }
  if (typeof body.baseUrl !== 'string' || body.baseUrl === '') {
    bad('invalid_request', 'baseUrl is required in every integrationMode, including receive_only.');
  }
  if (body.integrationMode !== undefined && !INTEGRATION_MODES.includes(body.integrationMode)) {
    bad('invalid_request', `integrationMode must be one of: ${INTEGRATION_MODES.join(' | ')}.`);
  }
  if (
    body.credentialScope !== undefined &&
    !['reseller', 'tenant'].includes(body.credentialScope)
  ) {
    bad('invalid_request', 'credentialScope must be "reseller" or "tenant".');
  }
  const credentialScope = body.credentialScope ?? 'reseller';
  if (credentialScope === 'reseller') {
    if (!body.externalCredentials || typeof body.externalCredentials !== 'object') {
      bad('invalid_request', 'externalCredentials is required at credentialScope "reseller".');
    }
  } else if (body.externalCredentials !== undefined) {
    bad(
      'invalid_request',
      'externalCredentials does not belong here at credentialScope "tenant": it comes with ' +
        'each POST .../integration/attach.',
    );
  }
  for (const [key, where] of Object.entries(TENANT_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      bad('invalid_request', `${key} is a TENANT setting. It belongs to ${where}.`);
    }
  }
  validateDeclared(body.declaredCapabilities, bad);

  const mode = INTEGRATION_MODES.includes(body.integrationMode)
    ? body.integrationMode
    : 'query_and_send';
  validateSyncConfig(body.syncConfig, mode, bad);

  return { errors, mode, credentialScope, syncConfig: body.syncConfig ?? {} };
}

/**
 * Validates PATCH /api/v1/resellers/me/integrations/{provider} (2.3, 7.1).
 *
 * Rotation is never a side effect: a credential or webhook secret here is a
 * 400 naming the PUT that does it.
 */
function validatePatch(rawBody, stored, tenants) {
  const errors = [];
  const bad = (error, message) => errors.push({ error, message });
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  if (body !== rawBody) bad('invalid_request', 'The body must be a JSON object.');

  if (body.externalCredentials !== undefined) {
    bad(
      'invalid_request',
      'externalCredentials is not patchable: use PUT /integrations/{provider}/credentials.',
    );
  }
  if (body.webhookSecret !== undefined) {
    bad(
      'invalid_request',
      'webhookSecret is not patchable: use PUT /integrations/{provider}/webhook-secret.',
    );
  }
  for (const [key, where] of Object.entries(TENANT_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      bad('invalid_request', `${key} is a TENANT setting. It belongs to ${where}.`);
    }
  }
  if (body.integrationMode !== undefined && !INTEGRATION_MODES.includes(body.integrationMode)) {
    bad('invalid_request', `integrationMode must be one of: ${INTEGRATION_MODES.join(' | ')}.`);
  }
  validateDeclared(body.declaredCapabilities, bad);

  const mode = INTEGRATION_MODES.includes(body.integrationMode)
    ? body.integrationMode
    : stored.integrationMode;
  if (body.syncConfig?.products && 'mode' in body.syncConfig.products) {
    bad(
      'invalid_sync_config',
      'syncConfig.products.mode is not settable: patch integrationMode instead.',
    );
  }
  const merged = mergeSyncConfig(stored.syncConfig, body.syncConfig);
  validateSyncConfig(merged, mode, bad);

  const stranded = MODE_SHAPES[mode].orderDelivery
    ? []
    : tenants.filter(([, connection]) => connection.orderStatusWrite === true);
  if (stranded.length > 0) {
    bad(
      'order_status_write_conflict',
      `integrationMode "${mode}" delivers no orders, but ${stranded.length} attached ` +
        `customer(s) opted into orderStatusWrite: ${stranded.map(([id]) => id).join(', ')}.`,
    );
  }

  const touchesSchedule =
    body.integrationMode !== undefined ||
    ['enabled', 'frequency', 'scheduleExpression'].some((key) => key in (body.syncConfig ?? {}));

  return { errors, mode, syncConfig: merged, touchesSchedule };
}

/**
 * Validates POST .../tenants/{tenantId}/integration/attach (contract 2.2), and
 * the per-tenant PATCH that takes the same fields.
 *
 * An INTEGRATION-level field here is a 400 that names where it belongs: this
 * is exactly the mistake the removed `connect` made impossible to notice.
 */
function validateAttach(rawBody, integration, stored) {
  const errors = [];
  const bad = (error, message) => errors.push({ error, message });
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  if (body !== rawBody) bad('invalid_request', 'The body must be a JSON object.');

  if (!integration) {
    bad(
      'integration_not_found',
      `No integration exists for provider "${body.provider ?? '(missing)'}". Create it once ` +
        'with POST /api/v1/resellers/me/integrations.',
    );
  }
  for (const [key, where] of Object.entries(INTEGRATION_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      bad(
        'invalid_request',
        `${key} is an INTEGRATION setting, shared by every tenant of yours. It belongs to ` +
          `${where}. Attaching a customer must never reconfigure the others.`,
      );
    }
  }
  if (body.orderStatusWrite !== undefined && typeof body.orderStatusWrite !== 'boolean') {
    bad('invalid_request', 'orderStatusWrite must be a boolean. The string "true" is not one.');
  }
  if (body.externalCredentials !== undefined && integration?.credentialScope !== 'tenant') {
    bad('invalid_request', 'externalCredentials belongs here only at credentialScope "tenant".');
  }

  const mode = integration?.integrationMode ?? 'query_and_send';
  const orderStatusWrite =
    typeof body.orderStatusWrite === 'boolean'
      ? body.orderStatusWrite
      : (stored?.orderStatusWrite ?? false);
  if (orderStatusWrite && !MODE_SHAPES[mode].orderDelivery) {
    bad(
      'invalid_request',
      'orderStatusWrite requires an integrationMode that delivers orders — ' +
        `'${mode}' never sends this reseller an order to report a status on`,
    );
  }

  return {
    errors,
    mode,
    orderStatusWrite,
    orderDeliveryStatus: body.orderDeliveryStatus ?? stored?.orderDeliveryStatus ?? 'confirmed',
    externalTenantId: body.externalTenantId ?? stored?.externalTenantId ?? null,
  };
}

function validateDeclared(declared, bad) {
  if (declared === undefined) return;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    bad('invalid_request', 'declaredCapabilities must be an object of boolean capability keys.');
    return;
  }
  for (const [key, value] of Object.entries(declared)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      bad(
        'invalid_request',
        `declaredCapabilities.${key} is not a capability. Accepted: ${CAPABILITY_KEYS.join(', ')}.` +
          (key === 'integrationMode'
            ? ' integrationMode is a TOP-LEVEL field of the integration body.'
            : key === 'orderStatusWrite'
              ? ' orderStatusWrite is a TENANT field - it belongs to the attach body.'
              : ''),
      );
    } else if (typeof value !== 'boolean') {
      bad('invalid_request', `declaredCapabilities.${key} must be a boolean.`);
    }
  }
}

/* ========================================================================== */
/* Contract 6.1 - order.status, both columns                                  */
/* ========================================================================== */

const LADDER = ['draft', 'pending', 'confirmed', 'processing', 'shipped', 'delivered'];
const EXCEPTIONS = ['cancelled', 'refunded'];

function toIntegrationStatus(state) {
  if (['accepted', 'acknowledged', 'ack'].includes(state)) return 'accepted';
  if (['fulfilled', 'completed', 'shipped', 'delivered'].includes(state)) return 'completed';
  if (['cancelled', 'canceled'].includes(state)) return 'cancelled';
  if (['returned', 'return', 'refunded', 'not_delivered', 'undelivered'].includes(state))
    return 'returned';
  if (['rejected', 'failed', 'error'].includes(state)) return 'manual_review';
  return null;
}

/** Derived from the RAW state: `shipped` and `delivered` both collapse above. */
function toOrderStatus(state) {
  if (['accepted', 'acknowledged', 'ack'].includes(state)) return 'confirmed';
  if (['shipped', 'fulfilled'].includes(state)) return 'shipped';
  if (['delivered', 'completed'].includes(state)) return 'delivered';
  if (['cancelled', 'canceled'].includes(state)) return 'cancelled';
  if (['returned', 'return', 'refunded', 'not_delivered', 'undelivered'].includes(state))
    return 'refunded';
  return null;
}

function resolveTransition(currentStatus, state, orderStatusWrite) {
  const integrationStatus = toIntegrationStatus(state);
  if (integrationStatus === null) {
    return {
      outcome: 'rejected',
      integrationStatus: null,
      orderStatus: null,
      detail: 'rejected; unknown_order_state',
      errorCode: 'unknown_order_state',
    };
  }
  const unchanged = (reason) => ({
    outcome: 'unchanged',
    integrationStatus,
    orderStatus: null,
    detail: `completed; status unchanged (${reason})`,
    errorCode: null,
  });

  if (!orderStatusWrite) return unchanged('status_write_disabled');

  const target = toOrderStatus(state);
  if (target === null) return unchanged('unmapped_state');
  if (target === currentStatus) return unchanged('already_current');

  const applied = () => ({
    outcome: 'applied',
    integrationStatus,
    orderStatus: target,
    detail: `completed; status ${currentStatus}→${target}`,
    errorCode: null,
  });

  if (EXCEPTIONS.includes(target)) return applied();
  if (EXCEPTIONS.includes(currentStatus)) {
    return {
      outcome: 'rejected',
      integrationStatus: 'manual_review',
      orderStatus: null,
      detail: 'rejected; order_status_conflict',
      errorCode: 'order_status_conflict',
    };
  }
  return LADDER.indexOf(target) > LADDER.indexOf(currentStatus) ? applied() : unchanged('backward');
}

function findOrder(reference) {
  if (!reference) return undefined;
  return orders.get(reference);
}

/**
 * Applies an order.status event the way WeAreDA's queue would, and records the
 * integration_operations row (result.detail / last_error_code).
 */
function applyOrderStatus(event, tenantId, operationId) {
  // orderStatusWrite is per TENANT (contract 2, 6.1): it lives on the
  // connection, never on the reseller-wide integration.
  const connection = connections.get(tenantId ?? '') ?? {};
  const orderStatusWrite = connection.orderStatusWrite === true;
  const reference = event.order?.external_order_id ?? event.order?.order_number;
  const order = findOrder(event.order?.external_order_id) ?? findOrder(event.order?.order_number);

  if (!order) {
    operations.push({
      operationId,
      type: 'order.status',
      reference,
      state: event.order?.state,
      status: 'rejected',
      result: { detail: 'rejected; order_not_found' },
      last_error_code: 'order_not_found',
    });
    return;
  }

  const verdict = resolveTransition(order.status, event.order?.state ?? '', orderStatusWrite);

  if (verdict.integrationStatus) order.integration_status = verdict.integrationStatus;
  if (verdict.outcome === 'applied') {
    order.status = verdict.orderStatus;
    // Filled in when blank, NEVER overwritten.
    const now = new Date().toISOString();
    if (verdict.orderStatus === 'shipped' && !order.shipped_at) order.shipped_at = now;
    if (verdict.orderStatus === 'delivered' && !order.delivered_at) order.delivered_at = now;
  }

  operations.push({
    operationId,
    type: 'order.status',
    reference,
    state: event.order?.state,
    status: verdict.outcome === 'rejected' ? 'rejected' : 'completed',
    result: { detail: verdict.detail },
    last_error_code: verdict.errorCode,
    order: { ...order },
  });
}

/* ========================================================================== */
/* Webhook transport (contract 6.0)                                           */
/* ========================================================================== */

function secretFor(connectionId) {
  // One signing secret per RESELLER (contract 9), reached through whichever
  // customer's connection the webhook came in on.
  for (const connection of connections.values()) {
    if (connection.connectionId === connectionId) {
      return integrations.get(connection.provider)?.webhookSecret || '';
    }
  }
  return SECRET;
}

function verify(rawBody, signature, secret) {
  // A connection with NO configured webhook secret is never accepted
  // unauthenticated - it is always 401.
  if (!signature || !secret) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`,
    'utf8',
  );
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function timestampIsFresh(header) {
  if (!header) return true; // the header is optional
  const value = Number(header);
  if (!Number.isFinite(value)) return false;
  // Accept seconds or milliseconds, as the contract allows both.
  const seconds = value > 1e11 ? value / 1000 : value;
  return Math.abs(Date.now() / 1000 - seconds) <= REPLAY_WINDOW_SECONDS;
}

const CONTAINERS = {
  'order.status': 'order',
  'stock.updated': 'items',
  'product.updated': 'products',
  'invoice.issued': 'invoice',
};

function classify(event) {
  if (event && typeof event === 'object' && 'events' in event) {
    return { error: 'multiple_event_types' };
  }
  const type = event?.type;
  if (typeof type !== 'string' || !(type in CONTAINERS)) {
    return { error: 'unsupported_event' };
  }
  const foreign = Object.entries(CONTAINERS).filter(
    ([otherType, container]) => otherType !== type && container in event,
  );
  if (foreign.length > 0) return { error: 'multiple_event_types' };

  if (
    type === 'product.updated' &&
    Array.isArray(event.products) &&
    event.products.length > MAX_PRODUCTS
  ) {
    return { error: 'too_many_items', max: MAX_PRODUCTS };
  }
  return { type };
}

/**
 * Event id precedence (contract 3.2):
 *   X-WeAreDA-Event-Id  ->  body.event.id / body.eventId / body.id  ->  a
 *   content hash of the RAW body.
 *
 * The last rung is the trap: send the same payload twice with no distinct
 * event id and the second one dedups SILENTLY - 200 {deduped:true}, nothing
 * applied. Give every event its own id.
 */
function resolveEventId(headerValue, event, rawBody) {
  if (headerValue) return { id: String(headerValue), source: 'header' };
  const fromBody = event?.event?.id ?? event?.eventId ?? event?.id;
  if (fromBody) return { id: String(fromBody), source: 'body' };
  return {
    id: `sha256:${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 32)}`,
    source: 'content-hash',
  };
}

function describe(event) {
  switch (event.type) {
    case 'stock.updated':
      return (event.items ?? [])
        .map((item) => {
          const ref = item.external_variant_id ?? item.external_product_id ?? item.sku;
          return `    ${ref} -> ${item.quantity} (absolute)`;
        })
        .join('\n');
    case 'order.status':
      return `    ${event.order?.external_order_id ?? event.order?.order_number} -> ${event.order?.state}`;
    case 'product.updated':
      return (
        `    ${event.products?.length} product(s): ` +
        (event.products ?? [])
          .map((p) => `${p.id}${p.status === 'archived' ? ' (archived)' : ''}`)
          .join(', ')
      );
    case 'invoice.issued':
      return (
        `    ${event.invoice?.external_invoice_id} ${event.invoice?.total} ${event.invoice?.currency}` +
        (event.invoice?.document_url ? `\n    document: ${event.invoice.document_url}` : '')
      );
    default:
      return '';
  }
}

/* ========================================================================== */
/* Routing                                                                    */
/* ========================================================================== */

// INTEGRATION scope: the collection, one provider, and its two rotation paths.
const INTEGRATIONS_RE =
  /^\/api\/v1\/resellers\/me\/integrations(?:\/([^/]+))?(?:\/(credentials|webhook-secret))?$/;
// TENANT scope, including the removed `connect` (410) and the bare PATCH path.
const TENANT_INTEGRATION_RE =
  /^\/api\/v1\/resellers\/me\/tenants\/([^/]+)\/integration(?:\/(attach|connect|status|test-connection|disconnect))?$/;
const WEBHOOK_RE = /^\/api\/v1\/reseller-webhooks\/([^/?]+)/;

/** The tenant whose integration a webhook connection belongs to. */
function tenantForConnection(connectionId) {
  for (const [tenantId, connection] of connections.entries()) {
    if (connection.connectionId === connectionId) return tenantId;
  }
  return null;
}

/** The INTEGRATION as GET/POST/PATCH /integrations return it (contract 2.1, 2.3). */
function integrationBody(integration, extra = {}) {
  const shape = MODE_SHAPES[integration.integrationMode];
  return {
    provider: integration.provider,
    baseUrl: integration.baseUrl,
    authType: integration.authType ?? 'api_key',
    credentialScope: integration.credentialScope,
    webhookSecretStatus: integration.webhookSecret ? 'configured' : 'missing',
    integrationMode: integration.integrationMode,
    orderDeliveryEnabled: shape.orderDelivery,
    productsSyncMode: shape.productsSyncMode,
    effectiveCapabilities: effectiveCapabilities(integration.integrationMode),
    syncConfig: integration.syncConfig ?? {},
    connectedTenants: [...connections.entries()]
      .filter(([, connection]) => connection.provider === integration.provider)
      .map(([tenantId, connection]) => ({
        tenantId,
        externalTenantId: connection.externalTenantId ?? null,
      })),
    ...extra,
  };
}

/** The TENANT connection, as attach and .../integration/status return it (2.2). */
function connectionResponse(tenantId, connection) {
  const integration = integrations.get(connection.provider) ?? {};
  const shape = MODE_SHAPES[integration.integrationMode];
  return {
    status: 'connected',
    provider: connection.provider,
    tenantId,
    externalTenantId: connection.externalTenantId ?? null,
    webhookUrl: `http://localhost:${PORT}/api/v1/reseller-webhooks/${connection.connectionId}`,
    webhookSecretStatus: integration.webhookSecret ? 'configured' : 'missing',
    integrationMode: integration.integrationMode,
    orderDeliveryEnabled: shape.orderDelivery,
    productsSyncMode: shape.productsSyncMode,
    orderStatusWrite: connection.orderStatusWrite,
    orderDeliveryStatus: connection.orderDeliveryStatus,
    effectiveCapabilities: effectiveCapabilities(integration.integrationMode),
    syncConfig: integration.syncConfig ?? {},
    // No schedule in a mode without reads - and any schedule left by a
    // previous mode is deleted.
    syncSchedule: shape.reads ? (integration.syncConfig?.frequency ?? 'daily') : null,
  };
}

function parseJson(rawBody, send) {
  try {
    return { body: rawBody === '' ? {} : JSON.parse(rawBody) };
  } catch {
    send(400, { error: 'invalid_request', message: 'Body is not JSON.' });
    return { failed: true };
  }
}

function rejected(send, errors, note) {
  const first = errors[0];
  const status =
    first.error === 'integration_exists' || first.error === 'order_status_write_conflict'
      ? 409
      : first.error === 'integration_not_found'
        ? 404
        : 400;
  return send(status, { error: first.error, message: first.message, errors }, note);
}

/* -------------------------------------------------------------------------- */
/* INTEGRATION scope - /api/v1/resellers/me/integrations (contract 2.1, 2.3)   */
/* -------------------------------------------------------------------------- */

function handleIntegrations(request, rawBody, send, provider, sub) {
  if (request.headers['x-reseller-key'] !== RESELLER_KEY) {
    return send(401, { error: 'invalid_reseller_key' }, 'X-Reseller-Key does not match.');
  }

  /* ---- collection ---------------------------------------------------- */
  if (!provider) {
    if (request.method === 'GET') {
      return send(200, {
        integrations: [...integrations.values()].map((integration) => integrationBody(integration)),
      });
    }
    if (request.method !== 'POST') return send(404, { error: 'not_found' });

    const parsed = parseJson(rawBody, send);
    if (parsed.failed) return undefined;
    const body = parsed.body;

    const existing = integrations.get(body.provider);
    const verdict = validateCreate(body, existing);
    if (verdict.errors.length > 0) {
      return rejected(
        send,
        verdict.errors,
        existing
          ? 'A create is not an upsert: your other customers keep running on what is stored.'
          : 'Rejected whole - nothing was stored.',
      );
    }

    const ignored = Object.keys(body).filter((key) => !KNOWN_CREATE_KEYS.includes(key));
    const integration = {
      provider: body.provider,
      baseUrl: body.baseUrl,
      authType: body.authType ?? 'api_key',
      credentialScope: verdict.credentialScope,
      externalCredentials: body.externalCredentials,
      webhookSecret: body.webhookSecret ?? SECRET,
      integrationMode: verdict.mode,
      syncConfig: verdict.syncConfig,
    };
    integrations.set(integration.provider, integration);

    return send(
      201,
      integrationBody(integration),
      ignored.length > 0
        ? `Silently ignored unknown top-level key(s): ${ignored.join(', ')} (the real API says nothing).`
        : 'Created. Now attach each customer with POST .../integration/attach.',
    );
  }

  /* ---- one integration ------------------------------------------------ */
  const stored = integrations.get(provider);
  if (!stored) return send(404, { error: 'integration_not_found' }, 'No such integration.');

  if (sub === 'credentials' || sub === 'webhook-secret') {
    if (request.method !== 'PUT') return send(404, { error: 'not_found' });
    const parsed = parseJson(rawBody, send);
    if (parsed.failed) return undefined;

    if (sub === 'credentials') {
      if (!parsed.body.externalCredentials || typeof parsed.body.externalCredentials !== 'object') {
        return send(400, { error: 'invalid_request', message: 'externalCredentials is required.' });
      }
      stored.externalCredentials = parsed.body.externalCredentials;
      return send(
        200,
        { provider, rotated: 'credentials', affectedTenants: tenantsOf(provider).length },
        'Rotation is never a side effect of an edit - this is the only call that does it.',
      );
    }

    if (typeof parsed.body.webhookSecret !== 'string' || parsed.body.webhookSecret === '') {
      return send(400, { error: 'invalid_request', message: 'webhookSecret is required.' });
    }
    stored.webhookSecret = parsed.body.webhookSecret;
    return send(
      200,
      { provider, rotated: 'webhookSecret', affectedTenants: tenantsOf(provider).length },
      'One signing secret per reseller: sign every webhook with the new value from now on.',
    );
  }

  if (request.method === 'GET') return send(200, integrationBody(stored));

  if (request.method === 'PATCH') {
    const parsed = parseJson(rawBody, send);
    if (parsed.failed) return undefined;
    const body = parsed.body;

    const tenants = tenantsOf(provider);
    const verdict = validatePatch(body, stored, tenants);
    if (verdict.errors.length > 0) {
      return rejected(send, verdict.errors, 'Rejected whole - nothing was stored.');
    }

    if (body.baseUrl !== undefined) stored.baseUrl = body.baseUrl;
    if (body.authType !== undefined) stored.authType = body.authType;
    if (body.credentialScope !== undefined) stored.credentialScope = body.credentialScope;
    stored.integrationMode = verdict.mode;
    stored.syncConfig = verdict.syncConfig;

    return send(
      200,
      integrationBody(stored, {
        affectedTenants: tenants.length,
        schedulesReconciled: verdict.touchesSchedule ? tenants.length : 0,
      }),
      'A named syncConfig section is REPLACED whole, not deep-merged (7.1).',
    );
  }

  return send(404, { error: 'not_found' });
}

function tenantsOf(provider) {
  return [...connections.entries()].filter(([, connection]) => connection.provider === provider);
}

/* -------------------------------------------------------------------------- */
/* TENANT scope - /tenants/{tenantId}/integration/... (contract 2.2)           */
/* -------------------------------------------------------------------------- */

async function handleTenantIntegration(request, rawBody, send, tenantId, action) {
  if (request.headers['x-reseller-key'] !== RESELLER_KEY) {
    return send(401, { error: 'invalid_reseller_key' }, 'X-Reseller-Key does not match.');
  }

  // The one breaking change of this contract (2.3, 9).
  if (action === 'connect') {
    return send(
      410,
      {
        error: 'endpoint_removed',
        message:
          'POST .../integration/connect was removed: it wrote reseller-wide settings from a ' +
          'tenant-scoped URL, so connecting one customer rewrote every other customer of yours.',
        replacements: [
          'POST /api/v1/resellers/me/integrations',
          'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach',
        ],
      },
      'Create the integration once, then attach each customer.',
    );
  }

  const stored = connections.get(tenantId);

  if (action === 'status') {
    if (!stored)
      return send(404, { error: 'not_found' }, 'No integration attached to this tenant.');
    return send(200, connectionResponse(tenantId, stored));
  }

  if (action === 'disconnect') {
    if (!stored) return send(404, { error: 'not_found' }, 'Nothing attached to this tenant.');
    connections.delete(tenantId);
    return send(
      200,
      { status: 'disconnected', tenantId, provider: stored.provider },
      'This customer only. The integration and every other customer are untouched.',
    );
  }

  if (action === 'test-connection') {
    if (!stored)
      return send(404, { error: 'not_found' }, 'No integration attached to this tenant.');
    const integration = integrations.get(stored.provider) ?? {};
    // The connection test IS a read.
    if (!MODE_SHAPES[integration.integrationMode].reads) {
      return send(
        422,
        { error: 'test_connection_unavailable', reason: 'read_calls_disabled' },
        `integrationMode "${integration.integrationMode}" makes no read calls - nothing was called.`,
      );
    }
    const credentials =
      integration.credentialScope === 'tenant'
        ? stored.externalCredentials
        : integration.externalCredentials;
    try {
      const response = await fetch(integration.baseUrl, {
        headers: { 'X-API-Key': credentials?.apiKey ?? '', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      return send(
        response.ok ? 200 : 502,
        { ok: response.ok, statusCode: response.status },
        `Called GET ${integration.baseUrl}`,
      );
    } catch (error) {
      return send(502, { ok: false, error: String(error) }, `GET ${integration.baseUrl} failed.`);
    }
  }

  /* ---- attach, and the per-tenant PATCH that takes the same fields ----- */
  const parsed = parseJson(rawBody, send);
  if (parsed.failed) return undefined;
  const body = parsed.body;

  const provider = body.provider ?? stored?.provider;
  const integration = integrations.get(provider);
  const verdict = validateAttach(body, integration, stored);
  if (verdict.errors.length > 0) {
    return rejected(
      send,
      verdict.errors,
      'Rejected whole - and nothing at integration scope could have been written from here.',
    );
  }

  const connection = {
    connectionId: stored?.connectionId ?? `conn_${randomUUID().slice(0, 8)}`,
    provider,
    orderDeliveryStatus: verdict.orderDeliveryStatus,
    orderStatusWrite: verdict.orderStatusWrite,
    externalTenantId: verdict.externalTenantId,
    externalCredentials: body.externalCredentials ?? stored?.externalCredentials,
  };
  connections.set(tenantId, connection);

  const ignored = Object.keys(body).filter(
    (key) =>
      ![
        'provider',
        'orderDeliveryStatus',
        'orderStatusWrite',
        'externalTenantId',
        'externalCredentials',
      ].includes(key),
  );

  return send(
    stored ? 200 : 201,
    connectionResponse(tenantId, connection),
    ignored.length > 0
      ? `Silently ignored unknown top-level key(s): ${ignored.join(', ')} (the real API says nothing).`
      : 'Idempotent per customer: an omitted field kept its stored value.',
  );
}

function handleWebhook(request, rawBody, send, connectionId) {
  const secret = secretFor(connectionId);
  if (!verify(rawBody, request.headers['x-weareda-signature'], secret)) {
    return send(401, { error: 'unauthorized' }, 'Signature does not match the raw body bytes.');
  }
  if (!timestampIsFresh(request.headers['x-weareda-timestamp'])) {
    return send(401, { error: 'stale_timestamp' }, 'Outside the +/-5 minute replay window.');
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BYTES) {
    return send(400, { error: 'too_many_items', max: MAX_PRODUCTS }, 'Body over 512 KB.');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return send(400, { error: 'unsupported_event' }, 'Body is not JSON.');
  }

  const verdict = classify(event);
  if (verdict.error) {
    return send(400, verdict, 'Rejected whole - nothing applied.');
  }

  const { id: eventId, source } = resolveEventId(
    request.headers['x-weareda-event-id'],
    event,
    rawBody,
  );
  // Dedup is scoped to connection + event type + event id (contract 5).
  const key = `${connectionId}:${verdict.type}:${eventId}`;
  if (seenEventIds.has(key)) {
    return send(
      200,
      { deduped: true, operationId: seenEventIds.get(key) },
      `Already processed (event id from the ${source}). NOTHING was applied.`,
    );
  }

  const operationId = `op_${randomUUID()}`;
  seenEventIds.set(key, operationId);

  // Inbound webhooks are accepted in EVERY integrationMode. The mode governs
  // what WeAreDA calls on the reseller, not what the reseller may publish.
  if (verdict.type === 'order.status') {
    applyOrderStatus(event, tenantForConnection(connectionId), operationId);
    const applied = operations[operations.length - 1];
    return send(
      202,
      { accepted: true, operationId },
      `Queued:\n${describe(event)}\n    result.detail: ${applied.result.detail}` +
        (applied.last_error_code ? `\n    last_error_code: ${applied.last_error_code}` : ''),
    );
  }

  return send(202, { accepted: true, operationId }, `Queued:\n${describe(event)}`);
}

/** Local aid, not part of the contract: stand in for an order WeAreDA delivered. */
function handleMockOrders(request, rawBody, send) {
  if (request.method === 'GET') return send(200, { orders: [...orders.values()] });

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return send(400, { error: 'invalid_request' });
  }
  const row = {
    external_order_id: body.external_order_id,
    order_number: body.order_number,
    status: body.status ?? 'confirmed',
    integration_status: body.integration_status ?? 'accepted',
    shipped_at: null,
    delivered_at: null,
  };
  if (row.external_order_id) orders.set(row.external_order_id, row);
  if (row.order_number) orders.set(row.order_number, row);
  return send(201, row, 'Registered an order for order.status events to move.');
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const path = (request.url ?? '').split('?')[0];

    const send = (status, body, note) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload);
      console.log(
        [
          RULE,
          'MOCK WeAreDA received a request',
          'Direction: Reseller -> WeAreDA',
          `${request.method} ${request.url}`,
          `Event id:  ${request.headers['x-weareda-event-id'] ?? '(none)'}`,
          `Signature: ${request.headers['x-weareda-signature'] ? 'present' : '(none)'}`,
          `Bytes:     ${Buffer.byteLength(rawBody, 'utf8')}`,
          note ? note : '',
          `Response:  ${status} ${payload}`,
          RULE,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    };

    const integrationsMatch = INTEGRATIONS_RE.exec(path);
    if (integrationsMatch) {
      const [, provider, sub] = integrationsMatch;
      return handleIntegrations(
        request,
        rawBody,
        send,
        provider ? decodeURIComponent(provider) : undefined,
        sub,
      );
    }

    const tenantMatch = TENANT_INTEGRATION_RE.exec(path);
    if (tenantMatch) {
      const [, tenantId, action] = tenantMatch;
      // The bare .../integration path is the per-tenant PATCH; everything else
      // has its own verb.
      const expected = action === 'status' ? 'GET' : action === undefined ? 'PATCH' : 'POST';
      if (request.method !== expected) return send(404, { error: 'not_found' });
      handleTenantIntegration(
        request,
        rawBody,
        send,
        decodeURIComponent(tenantId),
        action ?? 'attach',
      ).catch((error) => send(500, { error: 'internal_error', message: String(error) }));
      return;
    }

    if (path === '/api/v1/mock/orders') return handleMockOrders(request, rawBody, send);
    if (path === '/api/v1/mock/operations' && request.method === 'GET') {
      return send(200, { operations });
    }

    const webhookMatch = WEBHOOK_RE.exec(path);
    if (webhookMatch && request.method === 'POST') {
      return handleWebhook(request, rawBody, send, webhookMatch[1]);
    }

    return send(404, { error: 'not_found' });
  });
});

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('MOCK WeAreDA');
  console.log('='.repeat(50));
  console.log('');
  console.log('This is NOT WeAreDA. It imitates the response contract (1.1, 2,');
  console.log('6.0, 6.1, 7.1) so you can test the Reseller -> WeAreDA direction locally.');
  console.log('');
  console.log('Put these in your .env:');
  console.log('');
  console.log(
    `  WEAREDA_WEBHOOK_URL=http://localhost:${PORT}/api/v1/reseller-webhooks/demo-connection`,
  );
  console.log(`  WEAREDA_WEBHOOK_SECRET=${SECRET}`);
  console.log(`  WEAREDA_API_BASE_URL=http://localhost:${PORT}`);
  console.log(`  WEAREDA_RESELLER_KEY=${RESELLER_KEY}`);
  console.log('  WEAREDA_TENANT_ID=tenant_demo');
  console.log('');
  console.log('Then run, for example (two scopes, two calls - contract 2):');
  console.log('  npm run cli -- integration:create --mode receive_and_send');
  console.log('  npm run cli -- integration:attach');
  console.log('  npm run cli -- stock P-1001 37 V-2001 5');
  console.log('');
  console.log('Inspect what the WeAreDA side did with your events:');
  console.log(`  curl http://localhost:${PORT}/api/v1/mock/operations`);
  console.log(`  curl http://localhost:${PORT}/api/v1/mock/orders`);
  console.log('='.repeat(50));
});
