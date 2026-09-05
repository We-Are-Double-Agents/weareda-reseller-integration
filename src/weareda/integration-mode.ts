/**
 * Integration configuration: the TWO SCOPES of contract 2.
 *
 * Contract 1.1 (the four shapes), 2 (the two scopes and their calls), 6.1
 * (what the opt-in does to an order.status event) and 7 / 7.1 (syncConfig
 * validation and its PATCH merge).
 *
 * ============================================================================
 * WHICH FIELD GOES WHERE
 * ============================================================================
 * Configuration has two scopes, and putting a field in the wrong one is the
 * mistake this module exists to catch:
 *
 *   INTEGRATION scope - one per (reseller, provider), SHARED BY EVERY TENANT
 *   POST /api/v1/resellers/me/integrations
 *     { provider, baseUrl, authType, credentialScope, externalCredentials,
 *       webhookSecret, integrationMode, declaredCapabilities, syncConfig }
 *
 *   TENANT scope - one per customer
 *   POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach
 *     { provider, orderDeliveryStatus, orderStatusWrite, externalTenantId,
 *       externalCredentials (ONLY at credentialScope 'tenant') }
 *
 * An integration-level field in an attach body is a 400 that NAMES where it
 * belongs, rather than being applied to every other customer you serve.
 *
 * `POST .../integration/connect` - which took both scopes in one body against
 * a tenant-scoped URL - is GONE (410 endpoint_removed, see
 * REMOVED_CONNECT_ENDPOINT below).
 * ============================================================================
 *
 * This file is the RESELLER's model of the WeAreDA-side rules: it lets the CLI
 * validate a body locally, before the round trip, and it lets the sandbox
 * behave the way the registration says WeAreDA will behave.
 */

/* -------------------------------------------------------------------------- */
/* integrationMode - four integration shapes (contract 1.1)                    */
/* -------------------------------------------------------------------------- */

export const INTEGRATION_MODES = [
  'query_and_send',
  'receive_and_send',
  'query_only',
  'receive_only',
] as const;

export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const DEFAULT_INTEGRATION_MODE: IntegrationMode = 'query_and_send';

/**
 * Four outbound calls exist from WeAreDA to the reseller, split along two
 * INDEPENDENT axes - do we ever READ from you, and do you ever RECEIVE AN
 * ORDER:
 *
 *   reads            GET /                     (connection test)
 *                    GET /products             (catalog pull)
 *   order delivery   POST /orders
 *                    POST /orders/{id}/cancel
 *
 * Inbound webhooks are NOT an axis. You may publish product.updated,
 * stock.updated, order.status and invoice.issued in EVERY mode, provided a
 * webhook secret is configured. The mode only governs what WeAreDA does.
 */
export interface IntegrationModeShape {
  /** WeAreDA calls `GET /` and `GET /products`. */
  reads: boolean;
  /** WeAreDA delivers orders and cancellations. */
  orderDelivery: boolean;
  /** Derived, never an input: how the catalog travels. */
  productsSyncMode: 'pull' | 'push';
  /** Endpoints the reseller has to implement. */
  mustImplement: string[];
  summary: string;
}

export const INTEGRATION_MODE_SHAPES: Record<IntegrationMode, IntegrationModeShape> = {
  query_and_send: {
    reads: true,
    orderDelivery: true,
    productsSyncMode: 'pull',
    mustImplement: ['GET /', 'GET /products', 'POST /orders', 'POST /orders/{id}/cancel'],
    summary: 'The default. WeAreDA reads your catalog on a schedule and delivers orders to you.',
  },
  receive_and_send: {
    reads: false,
    orderDelivery: true,
    productsSyncMode: 'push',
    mustImplement: ['POST /orders', 'POST /orders/{id}/cancel'],
    summary:
      'No reads: your catalog arrives as product.updated webhooks. Orders are still DELIVERED - ' +
      'delivering an order is a send, not a query.',
  },
  query_only: {
    reads: true,
    orderDelivery: false,
    productsSyncMode: 'pull',
    mustImplement: ['GET /', 'GET /products'],
    summary: 'WeAreDA pulls your catalog and never sends you an order.',
  },
  receive_only: {
    reads: false,
    orderDelivery: false,
    productsSyncMode: 'push',
    mustImplement: [],
    summary:
      'Publish-only. Nothing is ever called on your side - but a baseUrl is still required when ' +
      'you create the integration: it is registered, not called.',
  },
};

export function modeReads(mode: IntegrationMode): boolean {
  return INTEGRATION_MODE_SHAPES[mode].reads;
}

export function modeDeliversOrders(mode: IntegrationMode): boolean {
  return INTEGRATION_MODE_SHAPES[mode].orderDelivery;
}

/**
 * The mode DERIVES the catalog transport (contract 1.1). `productsSyncMode` is
 * a RESPONSE field, never an input - sending it at the top level of a request
 * body is silently dropped, and contradicting it in `syncConfig.products.mode`
 * is a `400`, not a precedence puzzle.
 */
export function productsSyncModeFor(mode: IntegrationMode): 'pull' | 'push' {
  return INTEGRATION_MODE_SHAPES[mode].productsSyncMode;
}

export function isIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === 'string' && (INTEGRATION_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the effective mode of an integration.
 *
 * BACK-COMPAT, no data migration: an integration configured before
 * `integrationMode` existed carries only `syncConfig.products.mode`. A stored
 * `"push"` resolves to `receive_and_send` - reads off, orders still delivered.
 * Anything else resolves to the default, `query_and_send`.
 *
 * Omitting `integrationMode` on a PATCH leaves the stored value unchanged,
 * which is why `stored` wins over the legacy products.mode.
 */
export function resolveIntegrationMode(input: {
  /** `integrationMode` from the request body, if the caller sent one. */
  requested?: unknown;
  /** The mode already stored for this reseller, if any. */
  stored?: IntegrationMode | null;
  /** Legacy `syncConfig.products.mode` of a pre-`integrationMode` integration. */
  storedProductsMode?: 'pull' | 'push' | null;
}): IntegrationMode {
  if (isIntegrationMode(input.requested)) return input.requested;
  if (input.stored) return input.stored;
  if (input.storedProductsMode === 'push') return 'receive_and_send';
  return DEFAULT_INTEGRATION_MODE;
}

/* -------------------------------------------------------------------------- */
/* declaredCapabilities - metadata only                                        */
/* -------------------------------------------------------------------------- */

/**
 * The only six keys `declaredCapabilities` accepts, all boolean-valued.
 * Anything else is `400 invalid_request`.
 *
 * Contract 2 names four capabilities as the platform's gates (productsRead,
 * stockRead, ordersWrite, invoices); `declaredCapabilities` additionally
 * accepts productsWrite and stockWebhooks, which no generic_http connector
 * uses. That is harmless precisely because the declaration enables nothing.
 *
 * It is METADATA ONLY. Effective capabilities are computed as
 *
 *     connector support  n  platform ceiling  n  mode
 *
 * and the reseller's declaration is not an input to that. Declaring a
 * capability never enables anything - a reseller cannot self-grant.
 */
export const DECLARED_CAPABILITY_KEYS = [
  'productsRead',
  'productsWrite',
  'stockRead',
  'stockWebhooks',
  'ordersWrite',
  'invoices',
] as const;

export type CapabilityKey = (typeof DECLARED_CAPABILITY_KEYS)[number];
export type CapabilityMap = Record<CapabilityKey, boolean>;

/** What the `generic_http` connector in this repository can actually do. */
export const CONNECTOR_SUPPORT: CapabilityMap = {
  productsRead: true,
  // There is no endpoint in the contract for WeAreDA to WRITE products to you,
  // so no generic_http connector supports it. Declaring it changes nothing -
  // which is the point of the declaration being metadata.
  productsWrite: false,
  stockRead: true,
  stockWebhooks: true,
  ordersWrite: true,
  invoices: true,
};

/** The platform ceiling is WeAreDA's to set; a reseller can only observe it. */
export const OPEN_PLATFORM_CEILING: CapabilityMap = {
  productsRead: true,
  productsWrite: true,
  stockRead: true,
  stockWebhooks: true,
  ordersWrite: true,
  invoices: true,
};

/**
 * connector support n platform ceiling n mode.
 *
 * The mode's only capability effect is `ordersWrite`: in a mode without order
 * delivery it is switched OFF, so orders never enter the delivery queue at
 * all. Nothing is queued and later refused.
 *
 * Note what the mode does NOT switch off: `productsRead`. That one permission
 * authorizes your catalog in BOTH directions (contract 2), and the push
 * transport of a `receive_*` mode still needs it. "Reads off" is a decision
 * about which HTTP calls WeAreDA makes, not about which permissions exist.
 */
export function computeEffectiveCapabilities(
  mode: IntegrationMode,
  options: { connectorSupport?: CapabilityMap; platformCeiling?: CapabilityMap } = {},
): CapabilityMap {
  const connector = options.connectorSupport ?? CONNECTOR_SUPPORT;
  const ceiling = options.platformCeiling ?? OPEN_PLATFORM_CEILING;
  const delivers = modeDeliversOrders(mode);

  const effective = {} as CapabilityMap;
  for (const key of DECLARED_CAPABILITY_KEYS) {
    const allowedByMode = key === 'ordersWrite' ? delivers : true;
    effective[key] = connector[key] && ceiling[key] && allowedByMode;
  }
  return effective;
}

/* -------------------------------------------------------------------------- */
/* The two scopes (contract 2)                                                 */
/* -------------------------------------------------------------------------- */

export type AuthType = 'api_key' | 'bearer' | 'basic' | 'custom';

export const AUTH_TYPES: readonly AuthType[] = ['api_key', 'bearer', 'basic', 'custom'];

/**
 * Who owns the connector credential (contract 2).
 *
 *   reseller - ONE credential for every tenant. It is sent when the
 *              integration is created, and rotated with its own PUT.
 *   tenant   - one credential per customer. It is NOT sent at creation (there
 *              is no customer yet to own it); it comes with each attach.
 */
export const CREDENTIAL_SCOPES = ['reseller', 'tenant'] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];
export const DEFAULT_CREDENTIAL_SCOPE: CredentialScope = 'reseller';

export function isCredentialScope(value: unknown): value is CredentialScope {
  return typeof value === 'string' && (CREDENTIAL_SCOPES as readonly string[]).includes(value);
}

/** POST /api/v1/resellers/me/integrations - contract 2.1. Shared by all tenants. */
export interface CreateIntegrationBody {
  provider: string;
  baseUrl: string;
  authType?: AuthType;
  credentialScope?: CredentialScope;
  /** Required at reseller scope; forbidden at tenant scope (it comes at attach). */
  externalCredentials?: Record<string, string>;
  /** Optional, but REQUIRED before you can send us a webhook. */
  webhookSecret?: string;
  integrationMode?: IntegrationMode;
  /** Metadata only - six boolean keys, and it enables nothing. */
  declaredCapabilities?: Partial<CapabilityMap>;
  syncConfig?: SyncConfig;
  /** Anything else is silently ignored by WeAreDA (see KNOWN_CREATE_KEYS). */
  [key: string]: unknown;
}

/**
 * POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach - contract
 * 2.2. Per customer, and it can never reach integration scope.
 *
 * The same body shape is accepted by
 * PATCH /api/v1/resellers/me/tenants/{tenantId}/integration.
 */
export interface AttachTenantBody {
  /** Which of your integrations to attach this customer to. */
  provider: string;
  orderDeliveryStatus?: string;
  /** Contract 6.1. STRICT boolean, default `false`. `"true"` is a `400`. */
  orderStatusWrite?: boolean;
  /** Your own id for this customer, if you have one. */
  externalTenantId?: string;
  /** ONLY at credentialScope 'tenant'. */
  externalCredentials?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * PATCH /api/v1/resellers/me/integrations/{provider} - contract 2.3 / 7.1.
 *
 * Partial: an omitted field is left alone. `syncConfig` is MERGED by the rules
 * of 7.1 (named top-level keys replaced whole, `null` deletes).
 *
 * Credentials and the webhook secret are deliberately NOT here: rotation is
 * never a side effect of an edit, it has its own PUT.
 */
export interface PatchIntegrationBody {
  baseUrl?: string;
  authType?: AuthType;
  credentialScope?: CredentialScope;
  declaredCapabilities?: Partial<CapabilityMap>;
  integrationMode?: IntegrationMode;
  syncConfig?: SyncConfigPatch;
  [key: string]: unknown;
}

export interface SyncConfig {
  products?: {
    mode?: 'pull' | 'push';
    path?: string;
    pageParam?: string;
    pageSizeParam?: string;
    sinceParam?: string;
    pageSize?: number;
    itemsKey?: string | null;
    fieldMap?: Record<string, string>;
  };
  orders?: {
    path?: string;
    idempotencyHeader?: string;
    orderIdField?: string;
    /**
     * Contract 4.3.2 / 7 - OPT-IN, default `false`.
     *
     * `true` means WeAreDA never delivers an order whose customer has no
     * fiscal identifier: the order is simply not yet eligible, and it is
     * delivered automatically - within a minute - once the tenant completes
     * the contact. Nothing is parked and nothing has to be re-queued.
     *
     * This is the answer for a reseller that cannot invoice without a tax id.
     * The wrong answer is rejecting such orders on arrival: a non-auth 4xx is
     * not retried, so it turns a waiting order into a manual-review ticket.
     */
    requiresTaxId?: boolean;
  };
  documentHosts?: string[];
  enabled?: boolean;
  frequency?: 'hourly' | 'daily' | 'weekly';
  scheduleExpression?: string;
}

/** A PATCH body's syncConfig: the same keys, and `null` to delete one (7.1). */
export type SyncConfigPatch = {
  [K in keyof SyncConfig]?: SyncConfig[K] | null;
};

/* -------------------------------------------------------------------------- */
/* The removed endpoint (contract 2.3, 9)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The ONE breaking change in this contract.
 *
 * `connect` took both scopes in one body against a tenant-scoped URL and wrote
 * the shared ones with an upsert, so connecting one customer rewrote the
 * baseUrl, auth type, credential scope, capabilities and syncConfig of all the
 * others - and rotated the shared credential as a side effect.
 *
 * It was retired as a new pair of paths, never as a redefinition of the same
 * one: the old path answers 410 and names its replacements.
 */
export const REMOVED_CONNECT_ENDPOINT = {
  status: 410,
  error: 'endpoint_removed',
  path: 'POST /api/v1/resellers/me/tenants/{tenantId}/integration/connect',
  replacements: [
    'POST /api/v1/resellers/me/integrations                              (once)',
    'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach     (per customer)',
  ],
  message:
    'POST .../integration/connect was removed. It wrote reseller-wide settings from a ' +
    'tenant-scoped URL, so connecting one customer rewrote every other customer of yours. ' +
    'Create the integration once with POST /api/v1/resellers/me/integrations, then attach ' +
    'each customer with POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach.',
} as const;

/* -------------------------------------------------------------------------- */
/* Whitelists (contract 7)                                                     */
/* -------------------------------------------------------------------------- */

const SYNC_CONFIG_KEYS = [
  'products',
  'orders',
  'documentHosts',
  'enabled',
  'frequency',
  'scheduleExpression',
] as const;

const SYNC_PRODUCTS_KEYS = [
  'mode',
  'path',
  'pageParam',
  'pageSizeParam',
  'sinceParam',
  'pageSize',
  'itemsKey',
  'fieldMap',
] as const;

const SYNC_ORDERS_KEYS = ['path', 'idempotencyHeader', 'orderIdField', 'requiresTaxId'] as const;

const FREQUENCIES = ['hourly', 'daily', 'weekly'] as const;

/**
 * Top-level keys of a CREATE body. Everything else at the top level is DROPPED
 * WITHOUT A WORD - including `productsSyncMode`, which is a response field and
 * a common mistake. This reference warns about them locally, before sending,
 * because a silent drop is indistinguishable from a feature that does not work.
 */
export const KNOWN_CREATE_KEYS = [
  'provider',
  'baseUrl',
  'authType',
  'credentialScope',
  'externalCredentials',
  'webhookSecret',
  'integrationMode',
  'declaredCapabilities',
  'syncConfig',
] as const;

/** Top-level keys of an ATTACH (or per-tenant PATCH) body. */
export const KNOWN_ATTACH_KEYS = [
  'provider',
  'orderDeliveryStatus',
  'orderStatusWrite',
  'externalTenantId',
  'externalCredentials',
] as const;

/** Top-level keys a PATCH of the integration accepts (contract 2.3). */
export const KNOWN_PATCH_KEYS = [
  'baseUrl',
  'authType',
  'credentialScope',
  'declaredCapabilities',
  'integrationMode',
  'syncConfig',
] as const;

/**
 * Integration-scope fields, and the call each one belongs to. Sending one of
 * these to the attach endpoint is a 400 that NAMES where it belongs, instead
 * of quietly reconfiguring every other customer you serve.
 */
const INTEGRATION_SCOPE_FIELDS: Record<string, string> = {
  baseUrl: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider}',
  authType: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider}',
  credentialScope: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider}',
  integrationMode: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider}',
  declaredCapabilities: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider}',
  syncConfig: 'POST /api/v1/resellers/me/integrations, or PATCH /integrations/{provider} (7.1)',
  webhookSecret: 'PUT /integrations/{provider}/webhook-secret - rotation is never a side effect',
};

/** Tenant-scope fields, for the mirror-image mistake on the integration calls. */
const TENANT_SCOPE_FIELDS: Record<string, string> = {
  orderDeliveryStatus: 'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach',
  orderStatusWrite: 'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach',
  externalTenantId: 'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach',
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type ValidationErrorCode =
  | 'invalid_request'
  | 'invalid_sync_config'
  | 'integration_exists'
  | 'integration_not_found'
  | 'order_status_write_conflict';

export interface ValidationError {
  status: 400 | 404 | 409;
  error: ValidationErrorCode;
  message: string;
}

/** Kept for readability at the call sites that only ever produce 400s. */
export type ConnectValidationError = ValidationError;

export interface StoredIntegration {
  provider?: string;
  /** Stored per RESELLER - shared by all its tenants. */
  integrationMode?: IntegrationMode | null;
  credentialScope?: CredentialScope | null;
  /** Legacy: the products.mode of a pre-`integrationMode` integration. */
  productsMode?: 'pull' | 'push' | null;
  syncConfig?: SyncConfig | null;
  webhookSecretConfigured?: boolean;
}

/** One customer attached to the integration (contract 2.2). */
export interface StoredTenantConnection {
  tenantId?: string;
  /** Stored per TENANT. */
  orderStatusWrite?: boolean | null;
  orderDeliveryStatus?: string | null;
  externalTenantId?: string | null;
}

export interface IntegrationValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Top-level keys WeAreDA will silently drop. */
  ignoredKeys: string[];
  /** The mode that will take effect (only meaningful when `ok`). */
  mode: IntegrationMode;
  credentialScope: CredentialScope;
  productsSyncMode: 'pull' | 'push';
  orderDeliveryEnabled: boolean;
  effectiveCapabilities: CapabilityMap;
  /** The syncConfig that would be stored - merged, for a PATCH (7.1). */
  syncConfig: SyncConfig;
  /** PATCH only: the blast radius, echoed by the real API (contract 2.3). */
  affectedTenants: number;
  schedulesReconciled: number;
}

export interface AttachValidationResult {
  ok: boolean;
  errors: ValidationError[];
  ignoredKeys: string[];
  orderStatusWrite: boolean;
  orderDeliveryStatus: string;
  externalTenantId: string | null;
  /** From the integration - a tenant never chooses it. */
  mode: IntegrationMode;
  orderDeliveryEnabled: boolean;
  effectiveCapabilities: CapabilityMap;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Contract 7: short alphanumeric field names, <= 64 chars. */
function isFieldName(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

/** Contract 7: a RELATIVE path starting with `/` - no scheme, host or `..`. */
function isRelativePath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('..') &&
    !/^\/*[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

/** Contract 7: a BARE hostname - never a URL, port, path, or IP literal. */
function isBareHostname(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (value.includes('/') || value.includes(':') || value.includes('@')) return false;
  // An IP literal is not a hostname: allow-listing one bypasses the SSRF
  // guard's whole point (contract 9).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

/** Contract 7: a valid HTTP header name (RFC 7230 token). */
function isHeaderName(value: unknown): boolean {
  return typeof value === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(value);
}

/**
 * Validates a syncConfig against the contract-7 whitelist. Unknown sections and
 * options are REJECTED, not silently ignored, so a typo surfaces when you send
 * it instead of looking like a feature that does not work.
 *
 * The SAME function validates a create body and the MERGED result of a patch
 * (contract 7.1: "a patch can never store something a create would have
 * refused").
 */
export function validateSyncConfig(
  sync: unknown,
  mode: IntegrationMode,
  report: (message: string) => void,
): void {
  if (sync === undefined) return;
  if (!isPlainObject(sync)) {
    report('syncConfig must be an object.');
    return;
  }

  for (const key of Object.keys(sync)) {
    if (!(SYNC_CONFIG_KEYS as readonly string[]).includes(key)) {
      report(
        `syncConfig.${key} is not a known option.` +
          (key === 'integrationMode'
            ? ' integrationMode is a TOP-LEVEL field of the integration body.'
            : key === 'orderStatusWrite'
              ? ' orderStatusWrite is a TENANT field - it belongs to the attach body.'
              : ''),
      );
    }
  }

  /* ---- products ------------------------------------------------------- */
  const products = sync.products;
  if (products !== undefined && products !== null) {
    if (!isPlainObject(products)) {
      report('syncConfig.products must be an object.');
    } else {
      for (const key of Object.keys(products)) {
        if (!(SYNC_PRODUCTS_KEYS as readonly string[]).includes(key)) {
          report(`syncConfig.products.${key} is not a known option.`);
        }
      }
      if (products.mode !== undefined && products.mode !== 'pull' && products.mode !== 'push') {
        report('syncConfig.products.mode must be "pull" or "push".');
      }
      if (products.path !== undefined && !isRelativePath(products.path)) {
        report(
          'syncConfig.products.path must be a relative path starting with "/" - ' +
            'no scheme, host or "..".',
        );
      }
      for (const key of ['pageParam', 'pageSizeParam', 'sinceParam'] as const) {
        if (products[key] !== undefined && !isFieldName(products[key])) {
          report(`syncConfig.products.${key} must be a short field name (<= 64 chars).`);
        }
      }
      if (products.itemsKey !== undefined && products.itemsKey !== null) {
        if (!isFieldName(products.itemsKey)) {
          report(
            'syncConfig.products.itemsKey must be a short field name, or null to auto-detect.',
          );
        }
      }
      if (products.pageSize !== undefined) {
        const size = products.pageSize;
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 500) {
          report('syncConfig.products.pageSize must be an integer between 1 and 500.');
        }
      }
      if (products.fieldMap !== undefined) {
        if (!isPlainObject(products.fieldMap)) {
          report('syncConfig.products.fieldMap must be an object of field names.');
        } else {
          for (const [from, to] of Object.entries(products.fieldMap)) {
            if (!isFieldName(from) || !isFieldName(to)) {
              report(
                `syncConfig.products.fieldMap.${from} must map one short field name to another.`,
              );
            }
          }
        }
      }
    }
  }

  /* ---- orders --------------------------------------------------------- */
  const orders = sync.orders;
  if (orders !== undefined && orders !== null) {
    if (!isPlainObject(orders)) {
      report('syncConfig.orders must be an object.');
    } else {
      for (const key of Object.keys(orders)) {
        if (!(SYNC_ORDERS_KEYS as readonly string[]).includes(key)) {
          report(`syncConfig.orders.${key} is not a known option.`);
        }
      }
      if (orders.path !== undefined && !isRelativePath(orders.path)) {
        report(
          'syncConfig.orders.path must be a relative path starting with "/" - ' +
            'no scheme, host or "..".',
        );
      }
      if (orders.idempotencyHeader !== undefined && !isHeaderName(orders.idempotencyHeader)) {
        report('syncConfig.orders.idempotencyHeader must be a valid HTTP header name.');
      }
      if (orders.orderIdField !== undefined && !isFieldName(orders.orderIdField)) {
        report('syncConfig.orders.orderIdField must be a short field name (<= 64 chars).');
      }
      // Contract 7: a boolean, like orderStatusWrite. The string "true" is not
      // a boolean here either.
      if (orders.requiresTaxId !== undefined && typeof orders.requiresTaxId !== 'boolean') {
        report(
          `syncConfig.orders.requiresTaxId must be a boolean ` +
            `(received ${JSON.stringify(orders.requiresTaxId)}). Default is false.`,
        );
      }
    }
  }

  /* ---- documentHosts --------------------------------------------------- */
  const hosts = sync.documentHosts;
  if (hosts !== undefined && hosts !== null) {
    if (!Array.isArray(hosts)) {
      report('syncConfig.documentHosts must be an array of bare hostnames.');
    } else {
      if (hosts.length > 10) {
        report(`syncConfig.documentHosts accepts at most 10 hostnames (received ${hosts.length}).`);
      }
      for (const host of hosts) {
        if (!isBareHostname(host)) {
          report(
            `syncConfig.documentHosts[${JSON.stringify(host)}] must be a BARE hostname ` +
              '("files.your-erp.com") - never a URL, port, path, or IP literal.',
          );
        }
      }
    }
  }

  /* ---- schedule -------------------------------------------------------- */
  if (sync.enabled !== undefined && typeof sync.enabled !== 'boolean') {
    report('syncConfig.enabled must be a boolean.');
  }
  if (
    sync.frequency !== undefined &&
    !(FREQUENCIES as readonly unknown[]).includes(sync.frequency)
  ) {
    report(`syncConfig.frequency must be one of: ${FREQUENCIES.join(' | ')}.`);
  }
  if (
    sync.scheduleExpression !== undefined &&
    !(
      typeof sync.scheduleExpression === 'string' &&
      /^(rate|cron)\(.+\)$/.test(sync.scheduleExpression)
    )
  ) {
    report('syncConfig.scheduleExpression must be a rate(…) or cron(…) expression.');
  }
}

/**
 * Contract 7.1 - the PATCH merge, which is NOT a deep merge.
 *
 *   - only the top-level keys named in the patch are touched,
 *   - a named section REPLACES the stored one whole,
 *   - `null` DELETES a key, resetting it to its default.
 *
 * So `{"products": {"path": "/v2"}}` makes `/v2` your entire products section:
 * read the current one back and send it with your change applied.
 */
export function mergeSyncConfig(current: SyncConfig = {}, patch?: SyncConfigPatch): SyncConfig {
  if (patch === undefined) return { ...current };
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as SyncConfig;
}

/**
 * Validates POST /api/v1/resellers/me/integrations (contract 2.1).
 *
 * `existing` is the integration already stored for this provider, if any: a
 * create against one is `409 integration_exists`. It is a CREATE, not an
 * upsert - it will never overwrite what your other customers are running on.
 */
export function validateCreateIntegrationBody(
  body: CreateIntegrationBody,
  existing?: StoredIntegration | null,
): IntegrationValidationResult {
  const errors: ValidationError[] = [];
  const invalid = (message: string) =>
    errors.push({ status: 400, error: 'invalid_request', message });
  const invalidSync = (message: string) =>
    errors.push({ status: 400, error: 'invalid_sync_config', message });

  if (existing) {
    errors.push({
      status: 409,
      error: 'integration_exists',
      message:
        `An integration already exists for provider "${existing.provider ?? body.provider}". ` +
        'This is a create, not an upsert: use PATCH /integrations/{provider} to change it, ' +
        'and .../credentials or .../webhook-secret to rotate a secret.',
    });
  }

  /* ---- provider / baseUrl --------------------------------------------- */
  if (typeof body.provider !== 'string' || body.provider === '') {
    invalid('provider is required (e.g. "generic_http").');
  }
  // Required in EVERY mode. A `receive_only` reseller is never called, but its
  // baseUrl is still registered - registered, not called.
  if (typeof body.baseUrl !== 'string' || body.baseUrl === '') {
    invalid('baseUrl is required in every integrationMode, including receive_only.');
  }

  if (body.authType !== undefined && !AUTH_TYPES.includes(body.authType)) {
    invalid(`authType must be one of: ${AUTH_TYPES.join(' | ')}.`);
  }

  /* ---- credentialScope ------------------------------------------------ */
  if (body.credentialScope !== undefined && !isCredentialScope(body.credentialScope)) {
    invalid(`credentialScope must be one of: ${CREDENTIAL_SCOPES.join(' | ')}.`);
  }
  const credentialScope = isCredentialScope(body.credentialScope)
    ? body.credentialScope
    : DEFAULT_CREDENTIAL_SCOPE;

  if (credentialScope === 'reseller') {
    if (
      !isPlainObject(body.externalCredentials) ||
      Object.keys(body.externalCredentials).length === 0
    ) {
      invalid('externalCredentials is required at credentialScope "reseller".');
    }
  } else if (body.externalCredentials !== undefined) {
    invalid(
      'externalCredentials does not belong here at credentialScope "tenant": there is no ' +
        'customer yet to own it. Send it with each POST .../integration/attach.',
    );
  }

  /* ---- tenant-scope fields in an integration body ---------------------- */
  for (const [key, where] of Object.entries(TENANT_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      invalid(`${key} is a TENANT setting. It belongs to ${where}.`);
    }
  }

  /* ---- integrationMode ------------------------------------------------ */
  if (body.integrationMode !== undefined && !isIntegrationMode(body.integrationMode)) {
    invalid(
      `integrationMode must be one of: ${INTEGRATION_MODES.join(' | ')} ` +
        `(received ${JSON.stringify(body.integrationMode)}).`,
    );
  }

  validateDeclaredCapabilities(body.declaredCapabilities, invalid);

  const mode = resolveIntegrationMode({ requested: body.integrationMode });
  const syncConfig = (body.syncConfig ?? {}) as SyncConfig;
  validateSyncConfig(body.syncConfig, mode, invalidSync);
  checkProductsModeAgainstMode(body.syncConfig, mode, invalidSync);

  const ignoredKeys = Object.keys(body).filter(
    (key) =>
      !(KNOWN_CREATE_KEYS as readonly string[]).includes(key) && !(key in TENANT_SCOPE_FIELDS),
  );

  return {
    ok: errors.length === 0,
    errors,
    ignoredKeys,
    mode,
    credentialScope,
    productsSyncMode: productsSyncModeFor(mode),
    orderDeliveryEnabled: modeDeliversOrders(mode),
    effectiveCapabilities: computeEffectiveCapabilities(mode),
    syncConfig,
    affectedTenants: 0,
    schedulesReconciled: 0,
  };
}

/**
 * Validates PATCH /api/v1/resellers/me/integrations/{provider} (contract 2.3,
 * 7.1).
 *
 * `tenants` are the customers currently attached: changing the mode reconciles
 * every one of their sync schedules, and is REFUSED with
 * `409 order_status_write_conflict` when it would strand a customer who opted
 * into orderStatusWrite (contract 6.1 - such a reseller would never receive an
 * order to report a status on).
 */
export function validatePatchIntegrationBody(
  body: PatchIntegrationBody,
  stored: StoredIntegration,
  tenants: StoredTenantConnection[] = [],
): IntegrationValidationResult {
  const errors: ValidationError[] = [];
  const invalid = (message: string) =>
    errors.push({ status: 400, error: 'invalid_request', message });
  const invalidSync = (message: string) =>
    errors.push({ status: 400, error: 'invalid_sync_config', message });

  /* ---- fields that are never patchable -------------------------------- */
  if (body.externalCredentials !== undefined) {
    invalid(
      'externalCredentials is not patchable. Rotation is never a side effect of an edit: ' +
        'use PUT /integrations/{provider}/credentials.',
    );
  }
  if (body.webhookSecret !== undefined) {
    invalid(
      'webhookSecret is not patchable. Rotation is never a side effect of an edit: ' +
        'use PUT /integrations/{provider}/webhook-secret.',
    );
  }
  for (const [key, where] of Object.entries(TENANT_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      invalid(`${key} is a TENANT setting. It belongs to ${where}.`);
    }
  }

  if (body.baseUrl !== undefined && (typeof body.baseUrl !== 'string' || body.baseUrl === '')) {
    invalid('baseUrl must be a non-empty https URL when you send it.');
  }
  if (body.authType !== undefined && !AUTH_TYPES.includes(body.authType)) {
    invalid(`authType must be one of: ${AUTH_TYPES.join(' | ')}.`);
  }
  if (body.credentialScope !== undefined && !isCredentialScope(body.credentialScope)) {
    invalid(`credentialScope must be one of: ${CREDENTIAL_SCOPES.join(' | ')}.`);
  }
  if (body.integrationMode !== undefined && !isIntegrationMode(body.integrationMode)) {
    invalid(
      `integrationMode must be one of: ${INTEGRATION_MODES.join(' | ')} ` +
        `(received ${JSON.stringify(body.integrationMode)}).`,
    );
  }

  validateDeclaredCapabilities(body.declaredCapabilities, invalid);

  /* ---- the merge, then the SAME validation a create would run ---------- */
  const mode = resolveIntegrationMode({
    requested: body.integrationMode,
    stored: stored.integrationMode ?? null,
    storedProductsMode: stored.productsMode ?? null,
  });
  const merged = mergeSyncConfig(stored.syncConfig ?? {}, body.syncConfig);

  // 7.1: products.mode is never settable through a patch - it is the legacy
  // spelling of integrationMode, and an explicit integrationMode supersedes it.
  if (
    isPlainObject(body.syncConfig) &&
    isPlainObject((body.syncConfig as Record<string, unknown>).products) &&
    'mode' in ((body.syncConfig as Record<string, unknown>).products as Record<string, unknown>)
  ) {
    invalidSync(
      'syncConfig.products.mode is not settable: it is the legacy spelling of integrationMode, ' +
        'and the mode derives the catalog transport. Patch integrationMode instead.',
    );
  }
  validateSyncConfig(merged, mode, invalidSync);
  checkProductsModeAgainstMode(merged, mode, invalidSync);

  /* ---- 409: a mode change that would strand a tenant ------------------- */
  const stranded = modeDeliversOrders(mode)
    ? []
    : tenants.filter((tenant) => tenant.orderStatusWrite === true);
  if (stranded.length > 0) {
    errors.push({
      status: 409,
      error: 'order_status_write_conflict',
      message:
        `integrationMode "${mode}" delivers no orders, but ${stranded.length} attached ` +
        `customer(s) opted into orderStatusWrite: ` +
        `${stranded.map((tenant) => tenant.tenantId ?? '(unknown)').join(', ')}. ` +
        'Turn the flag off on those tenants first, then change the mode.',
    });
  }

  const ignoredKeys = Object.keys(body).filter(
    (key) =>
      !(KNOWN_PATCH_KEYS as readonly string[]).includes(key) &&
      key !== 'externalCredentials' &&
      key !== 'webhookSecret' &&
      !(key in TENANT_SCOPE_FIELDS),
  );

  // Changing the mode or a schedule key reconciles EVERY attached customer's
  // schedule; the response reports the blast radius (contract 2.3).
  const touchesSchedule =
    body.integrationMode !== undefined ||
    (isPlainObject(body.syncConfig) &&
      ['enabled', 'frequency', 'scheduleExpression'].some(
        (key) => key in (body.syncConfig as Record<string, unknown>),
      ));

  return {
    ok: errors.length === 0,
    errors,
    ignoredKeys,
    mode,
    credentialScope: isCredentialScope(body.credentialScope)
      ? body.credentialScope
      : (stored.credentialScope ?? DEFAULT_CREDENTIAL_SCOPE),
    productsSyncMode: productsSyncModeFor(mode),
    orderDeliveryEnabled: modeDeliversOrders(mode),
    effectiveCapabilities: computeEffectiveCapabilities(mode),
    syncConfig: merged,
    affectedTenants: tenants.length,
    schedulesReconciled: touchesSchedule ? tenants.length : 0,
  };
}

/**
 * Validates POST .../tenants/{tenantId}/integration/attach (contract 2.2), and
 * the per-tenant PATCH that takes the same fields.
 *
 * Attaching is idempotent per customer and an omitted field keeps its stored
 * value, so re-attaching never silently flips a setting you did not send.
 */
export function validateAttachBody(
  body: AttachTenantBody,
  integration: StoredIntegration | null,
  stored: StoredTenantConnection = {},
): AttachValidationResult {
  const errors: ValidationError[] = [];
  const invalid = (message: string) =>
    errors.push({ status: 400, error: 'invalid_request', message });

  if (!integration) {
    errors.push({
      status: 404,
      error: 'integration_not_found',
      message:
        `No integration exists for provider "${body.provider ?? '(missing)'}". ` +
        'Create it once with POST /api/v1/resellers/me/integrations, then attach customers.',
    });
  }

  if (typeof body.provider !== 'string' || body.provider === '') {
    invalid(
      'provider is required: it names which of your integrations to attach this customer to.',
    );
  }

  /* ---- the scope guard ------------------------------------------------- */
  // An integration-level field here would reconfigure every OTHER customer of
  // yours - which is exactly what the removed `connect` did. It is a 400 that
  // names where the field belongs.
  for (const [key, where] of Object.entries(INTEGRATION_SCOPE_FIELDS)) {
    if (body[key] !== undefined) {
      invalid(
        `${key} is an INTEGRATION setting, shared by every tenant of yours. It belongs to ` +
          `${where}. Attaching a customer must never reconfigure the others.`,
      );
    }
  }

  /* ---- orderStatusWrite ------------------------------------------------ */
  // STRICT boolean. The string "true" is a 400, not a truthy value.
  if (body.orderStatusWrite !== undefined && typeof body.orderStatusWrite !== 'boolean') {
    invalid(
      `orderStatusWrite must be a boolean (received ${JSON.stringify(body.orderStatusWrite)}). ` +
        'The string "true" is not a boolean.',
    );
  }

  if (
    body.orderDeliveryStatus !== undefined &&
    (typeof body.orderDeliveryStatus !== 'string' || body.orderDeliveryStatus === '')
  ) {
    invalid('orderDeliveryStatus must be an order status, e.g. "confirmed".');
  }

  if (
    body.externalTenantId !== undefined &&
    (typeof body.externalTenantId !== 'string' || body.externalTenantId === '')
  ) {
    invalid('externalTenantId must be a non-empty string when you send it.');
  }

  /* ---- credentials, and where they are allowed ------------------------- */
  const credentialScope = integration?.credentialScope ?? DEFAULT_CREDENTIAL_SCOPE;
  if (body.externalCredentials !== undefined && credentialScope !== 'tenant') {
    invalid(
      'externalCredentials belongs here only at credentialScope "tenant". This integration ' +
        'uses one reseller-wide credential: rotate it with PUT /integrations/{provider}/credentials.',
    );
  }

  const mode = resolveIntegrationMode({
    stored: integration?.integrationMode ?? null,
    storedProductsMode: integration?.productsMode ?? null,
  });
  const orderStatusWrite =
    typeof body.orderStatusWrite === 'boolean'
      ? body.orderStatusWrite
      : (stored.orderStatusWrite ?? false);

  /* ---- cross-scope: orderStatusWrite vs the integration's mode ---------- */
  if (orderStatusWrite && !modeDeliversOrders(mode)) {
    invalid(
      'orderStatusWrite requires an integrationMode that delivers orders — ' +
        `'${mode}' never sends this reseller an order to report a status on`,
    );
  }

  const ignoredKeys = Object.keys(body).filter(
    (key) =>
      !(KNOWN_ATTACH_KEYS as readonly string[]).includes(key) && !(key in INTEGRATION_SCOPE_FIELDS),
  );

  return {
    ok: errors.length === 0,
    errors,
    ignoredKeys,
    orderStatusWrite,
    orderDeliveryStatus:
      typeof body.orderDeliveryStatus === 'string'
        ? body.orderDeliveryStatus
        : (stored.orderDeliveryStatus ?? 'confirmed'),
    externalTenantId:
      typeof body.externalTenantId === 'string'
        ? body.externalTenantId
        : (stored.externalTenantId ?? null),
    mode,
    orderDeliveryEnabled: modeDeliversOrders(mode),
    effectiveCapabilities: computeEffectiveCapabilities(mode),
  };
}

function validateDeclaredCapabilities(declared: unknown, invalid: (message: string) => void): void {
  if (declared === undefined) return;
  if (!isPlainObject(declared)) {
    invalid('declaredCapabilities must be an object of boolean-valued capability keys.');
    return;
  }
  for (const [key, value] of Object.entries(declared)) {
    if (!(DECLARED_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      invalid(
        `declaredCapabilities.${key} is not a capability. Accepted keys: ` +
          `${DECLARED_CAPABILITY_KEYS.join(', ')}.` +
          (key === 'integrationMode'
            ? ' integrationMode is a TOP-LEVEL field of the integration body.'
            : key === 'orderStatusWrite'
              ? ' orderStatusWrite is a TENANT field - it belongs to the attach body.'
              : ''),
      );
    } else if (typeof value !== 'boolean') {
      invalid(`declaredCapabilities.${key} must be a boolean.`);
    }
  }
}

/** The mode decides the catalog transport; contradicting it is a 400 (1.1). */
function checkProductsModeAgainstMode(
  sync: unknown,
  mode: IntegrationMode,
  invalidSync: (message: string) => void,
): void {
  if (!isPlainObject(sync) || !isPlainObject(sync.products)) return;
  const requested = sync.products.mode;
  const derived = productsSyncModeFor(mode);
  if ((requested === 'pull' || requested === 'push') && requested !== derived) {
    invalidSync(
      `syncConfig.products.mode "${requested}" contradicts integrationMode ` +
        `"${mode}", which derives "${derived}". The mode decides the catalog transport - ` +
        'this is a 400, not a precedence rule. Remove products.mode, or change the mode.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

/** The integration as WeAreDA returns it (contract 2.1, 2.3). */
export interface IntegrationResponse {
  provider: string;
  baseUrl: string;
  authType: AuthType;
  credentialScope: CredentialScope;
  webhookSecretStatus: 'configured' | 'missing';
  integrationMode: IntegrationMode;
  orderDeliveryEnabled: boolean;
  /** Derived from the mode. A RESPONSE field - never an input. */
  productsSyncMode: 'pull' | 'push';
  effectiveCapabilities: CapabilityMap;
  syncConfig?: SyncConfig;
  /** GET /integrations lists the customers attached to each one. */
  connectedTenants?: Array<{ tenantId: string; externalTenantId?: string | null }>;
  /** PATCH echoes the blast radius of what you just changed (contract 2.3). */
  affectedTenants?: number;
  schedulesReconciled?: number;
}

/** The response from attach and from GET .../integration/status (2.2). */
export interface IntegrationStatusResponse {
  status: 'connected' | 'disconnected';
  provider?: string;
  webhookUrl?: string;
  webhookSecretStatus?: 'configured' | 'missing';
  /** Echoed back on both endpoints. */
  integrationMode: IntegrationMode;
  orderDeliveryEnabled: boolean;
  /** Derived from the mode. A RESPONSE field - never an input. */
  productsSyncMode: 'pull' | 'push';
  orderStatusWrite: boolean;
  orderDeliveryStatus?: string;
  externalTenantId?: string | null;
  effectiveCapabilities: CapabilityMap;
  syncConfig?: SyncConfig;
  /** `null` in a mode without reads: no schedule is created, and any schedule
   *  left by a previous mode is deleted. */
  syncSchedule?: string | null;
}
