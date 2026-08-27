/**
 * Connect-time configuration: `integrationMode` and `orderStatusWrite`.
 *
 * Contract 1.1 (the four shapes), 2 (the connect body), 6.1 (what the opt-in
 * does to an order.status event) and 7 (syncConfig validation).
 *
 * ============================================================================
 * WHERE THESE FIELDS GO
 * ============================================================================
 * Both are TOP-LEVEL fields of the connect body, siblings of
 * `orderDeliveryStatus`:
 *
 *     POST /api/v1/resellers/me/tenants/{tenantId}/integration/connect
 *     {
 *       "provider": "generic_http",
 *       "baseUrl": "https://api.your-erp.com/v1",
 *       "orderDeliveryStatus": "confirmed",
 *       "integrationMode": "query_and_send",     <-- top level
 *       "orderStatusWrite": true                 <-- top level
 *     }
 *
 * Nested inside `declaredCapabilities` they are `400 invalid_request`; nested
 * inside `syncConfig` they are `400 invalid_sync_config`. Both mistakes cost
 * real debugging time, so this module rejects them with those exact codes.
 * ============================================================================
 *
 * This file is the RESELLER's model of the WeAreDA-side rules: it lets the CLI
 * validate a connect body locally, before the round trip, and it lets the
 * sandbox behave the way the mode says WeAreDA will behave.
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
      'Publish-only. Nothing is ever called on your side - but a baseUrl is still required at ' +
      'connect time: it is registered, not called.',
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
 * a RESPONSE field, never an input - sending it at the top level of the connect
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
 * Omitting `integrationMode` on a RECONNECT leaves the stored value unchanged,
 * which is why `stored` wins over the legacy products.mode.
 */
export function resolveIntegrationMode(input: {
  /** `integrationMode` from the connect body, if the caller sent one. */
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
/* The connect body                                                            */
/* -------------------------------------------------------------------------- */

export type AuthType = 'api_key' | 'bearer' | 'basic' | 'custom';

export interface ConnectBody {
  provider: string;
  baseUrl: string;
  authType?: AuthType;
  externalCredentials?: Record<string, string>;
  webhookSecret?: string;
  orderDeliveryStatus?: string;
  /** Top level (contract 1.1). Four values, default `query_and_send`. */
  integrationMode?: IntegrationMode;
  /** Top level (contract 6.1). STRICT boolean, default `false`. `"true"` is a `400`. */
  orderStatusWrite?: boolean;
  /** Metadata only - six boolean keys, and it enables nothing. */
  declaredCapabilities?: Partial<CapabilityMap>;
  syncConfig?: SyncConfig;
  /** Anything else is silently ignored by WeAreDA (see UNKNOWN_TOP_LEVEL). */
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
  orders?: { path?: string; idempotencyHeader?: string; orderIdField?: string };
  documentHosts?: string[];
  enabled?: boolean;
  frequency?: 'hourly' | 'daily' | 'weekly';
  scheduleExpression?: string;
}

/** Contract 7 - the whitelist. Unknown sections/options are REJECTED. */
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

const SYNC_ORDERS_KEYS = ['path', 'idempotencyHeader', 'orderIdField'] as const;

/**
 * Top-level keys WeAreDA knows. Everything else at the top level is DROPPED
 * WITHOUT A WORD - including `productsSyncMode`, which is a response field and
 * a common mistake. This reference warns about them locally, before sending,
 * because a silent drop is indistinguishable from a feature that does not work.
 */
const KNOWN_TOP_LEVEL = [
  'provider',
  'baseUrl',
  'authType',
  'externalCredentials',
  'webhookSecret',
  'orderDeliveryStatus',
  'integrationMode',
  'orderStatusWrite',
  'declaredCapabilities',
  'syncConfig',
] as const;

export interface ConnectValidationError {
  status: 400;
  error: 'invalid_request' | 'invalid_sync_config';
  message: string;
}

export interface ConnectValidationResult {
  ok: boolean;
  errors: ConnectValidationError[];
  /** Top-level keys WeAreDA will silently drop. */
  ignoredKeys: string[];
  /** The mode that will take effect (only meaningful when `ok`). */
  mode: IntegrationMode;
  orderStatusWrite: boolean;
  productsSyncMode: 'pull' | 'push';
  orderDeliveryEnabled: boolean;
  effectiveCapabilities: CapabilityMap;
}

export interface StoredIntegration {
  /** Stored per RESELLER - shared by all its tenants. */
  integrationMode?: IntegrationMode | null;
  /** Stored per TENANT. */
  orderStatusWrite?: boolean | null;
  /** Legacy: the products.mode of a pre-`integrationMode` integration. */
  productsMode?: 'pull' | 'push' | null;
}

/**
 * Validates a connect body exactly as WeAreDA does, and reports what would
 * take effect.
 *
 * Omitting either new field on a RECONNECT leaves the stored value unchanged,
 * which is why `stored` is passed in rather than assumed empty.
 */
export function validateConnectBody(
  body: ConnectBody,
  stored: StoredIntegration = {},
): ConnectValidationResult {
  const errors: ConnectValidationError[] = [];
  const invalid = (message: string) =>
    errors.push({ status: 400, error: 'invalid_request', message });
  const invalidSync = (message: string) =>
    errors.push({ status: 400, error: 'invalid_sync_config', message });

  /* ---- baseUrl -------------------------------------------------------- */
  // Required in EVERY mode. A `receive_only` reseller is never called, but its
  // baseUrl is still registered - registered, not called.
  if (typeof body.baseUrl !== 'string' || body.baseUrl === '') {
    invalid('baseUrl is required in every integrationMode, including receive_only.');
  }

  /* ---- integrationMode ------------------------------------------------ */
  if (body.integrationMode !== undefined && !isIntegrationMode(body.integrationMode)) {
    invalid(
      `integrationMode must be one of: ${INTEGRATION_MODES.join(' | ')} ` +
        `(received ${JSON.stringify(body.integrationMode)}).`,
    );
  }

  /* ---- orderStatusWrite ----------------------------------------------- */
  // STRICT boolean. The string "true" is a 400, not a truthy value.
  if (body.orderStatusWrite !== undefined && typeof body.orderStatusWrite !== 'boolean') {
    invalid(
      `orderStatusWrite must be a boolean (received ${JSON.stringify(body.orderStatusWrite)}). ` +
        'The string "true" is not a boolean.',
    );
  }

  /* ---- declaredCapabilities ------------------------------------------- */
  if (body.declaredCapabilities !== undefined) {
    const declared = body.declaredCapabilities as Record<string, unknown>;
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      invalid('declaredCapabilities must be an object of boolean-valued capability keys.');
    } else {
      for (const [key, value] of Object.entries(declared)) {
        if (!(DECLARED_CAPABILITY_KEYS as readonly string[]).includes(key)) {
          invalid(
            `declaredCapabilities.${key} is not a capability. Accepted keys: ` +
              `${DECLARED_CAPABILITY_KEYS.join(', ')}.` +
              (key === 'integrationMode' || key === 'orderStatusWrite'
                ? ` ${key} is a TOP-LEVEL connect field, a sibling of orderDeliveryStatus.`
                : ''),
          );
        } else if (typeof value !== 'boolean') {
          invalid(`declaredCapabilities.${key} must be a boolean.`);
        }
      }
    }
  }

  /* ---- syncConfig ----------------------------------------------------- */
  // Unknown keys INSIDE syncConfig are rejected loudly (contract 7), unlike
  // unknown keys at the top level of the body, which are dropped in silence.
  const sync = body.syncConfig as Record<string, unknown> | undefined;
  if (sync !== undefined) {
    if (sync === null || typeof sync !== 'object' || Array.isArray(sync)) {
      invalidSync('syncConfig must be an object.');
    } else {
      for (const key of Object.keys(sync)) {
        if (!(SYNC_CONFIG_KEYS as readonly string[]).includes(key)) {
          invalidSync(
            `syncConfig.${key} is not a known option.` +
              (key === 'integrationMode' || key === 'orderStatusWrite'
                ? ` ${key} is a TOP-LEVEL connect field, a sibling of orderDeliveryStatus.`
                : ''),
          );
        }
      }
      const products = sync.products as Record<string, unknown> | undefined;
      if (products && typeof products === 'object') {
        for (const key of Object.keys(products)) {
          if (!(SYNC_PRODUCTS_KEYS as readonly string[]).includes(key)) {
            invalidSync(`syncConfig.products.${key} is not a known option.`);
          }
        }
        if (products.mode !== undefined && products.mode !== 'pull' && products.mode !== 'push') {
          invalidSync(`syncConfig.products.mode must be "pull" or "push".`);
        }
      }
      const orders = sync.orders as Record<string, unknown> | undefined;
      if (orders && typeof orders === 'object') {
        for (const key of Object.keys(orders)) {
          if (!(SYNC_ORDERS_KEYS as readonly string[]).includes(key)) {
            invalidSync(`syncConfig.orders.${key} is not a known option.`);
          }
        }
      }
    }
  }

  /* ---- what would take effect ----------------------------------------- */
  const mode = resolveIntegrationMode({
    requested: body.integrationMode,
    stored: stored.integrationMode ?? null,
    storedProductsMode: stored.productsMode ?? null,
  });
  const orderStatusWrite =
    typeof body.orderStatusWrite === 'boolean'
      ? body.orderStatusWrite
      : (stored.orderStatusWrite ?? false);

  /* ---- cross-field: mode vs products.mode ------------------------------ */
  const requestedProductsMode = (sync?.products as { mode?: unknown } | undefined)?.mode;
  const derived = productsSyncModeFor(mode);
  if (
    (requestedProductsMode === 'pull' || requestedProductsMode === 'push') &&
    requestedProductsMode !== derived
  ) {
    invalidSync(
      `syncConfig.products.mode "${requestedProductsMode}" contradicts integrationMode ` +
        `"${mode}", which derives "${derived}". The mode decides the catalog transport - ` +
        'this is a 400, not a precedence rule. Remove products.mode, or change the mode.',
    );
  }

  /* ---- cross-field: orderStatusWrite vs mode --------------------------- */
  if (orderStatusWrite && !modeDeliversOrders(mode)) {
    invalid(
      'orderStatusWrite requires an integrationMode that delivers orders — ' +
        `'${mode}' never sends this reseller an order to report a status on`,
    );
  }

  const ignoredKeys = Object.keys(body).filter(
    (key) => !(KNOWN_TOP_LEVEL as readonly string[]).includes(key),
  );

  return {
    ok: errors.length === 0,
    errors,
    ignoredKeys,
    mode,
    orderStatusWrite,
    productsSyncMode: derived,
    orderDeliveryEnabled: modeDeliversOrders(mode),
    effectiveCapabilities: computeEffectiveCapabilities(mode),
  };
}

/** The response WeAreDA returns from connect and from GET .../integration/status. */
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
  effectiveCapabilities: CapabilityMap;
  syncConfig?: SyncConfig;
  /** `null` in a mode without reads: no schedule is created, and any schedule
   *  from a previous connect is deleted. */
  syncSchedule?: string | null;
}
