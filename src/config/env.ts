/**
 * Environment configuration for the reseller sandbox.
 *
 * The three authentication contexts of the WeAreDA reseller integration are
 * kept strictly separate here, because they use different credentials:
 *
 *   1. WeAreDA -> Reseller ............ RESELLER_API_KEY        (inbound)
 *   2. Reseller -> WeAreDA webhook .... WEAREDA_WEBHOOK_SECRET  (HMAC, outbound)
 *   3. Reseller -> WeAreDA read API ... WEAREDA_RESELLER_KEY    (X-Reseller-Key)
 */
import { config as loadDotenv } from 'dotenv';
import {
  CREDENTIAL_SCOPES,
  DEFAULT_CREDENTIAL_SCOPE,
  DEFAULT_INTEGRATION_MODE,
  INTEGRATION_MODES,
  isCredentialScope,
  isIntegrationMode,
  modeDeliversOrders,
  modeReads,
  productsSyncModeFor,
  type CredentialScope,
  type IntegrationMode,
} from '../weareda/integration-mode.js';

loadDotenv();

export type InboundAuthMode = 'api_key' | 'bearer' | 'basic' | 'custom' | 'none';

const INBOUND_AUTH_MODES: InboundAuthMode[] = ['api_key', 'bearer', 'basic', 'custom', 'none'];

function str(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * INTEGRATION_MODE - which of the four integration shapes this sandbox is
 * playing (contract 1.1). It decides which endpoints the server exposes, so that
 * a `receive_only` reseller really does answer 404 on `GET /products` instead
 * of merely claiming it would.
 */
function integrationMode(): IntegrationMode {
  const raw = str('INTEGRATION_MODE', DEFAULT_INTEGRATION_MODE).toLowerCase();
  if (!isIntegrationMode(raw)) {
    throw new Error(
      `INTEGRATION_MODE must be one of: ${INTEGRATION_MODES.join(', ')} (received "${raw}")`,
    );
  }
  return raw;
}

/**
 * CREDENTIAL_SCOPE - who owns the connector credential (contract 2).
 * `reseller` (the default) is one credential for every customer; `tenant` is
 * one per customer, sent with each attach rather than at creation.
 */
function credentialScope(): CredentialScope {
  const raw = str('CREDENTIAL_SCOPE', DEFAULT_CREDENTIAL_SCOPE).toLowerCase();
  if (!isCredentialScope(raw)) {
    throw new Error(
      `CREDENTIAL_SCOPE must be one of: ${CREDENTIAL_SCOPES.join(', ')} (received "${raw}")`,
    );
  }
  return raw;
}

function authMode(): InboundAuthMode {
  const raw = str('RESELLER_AUTH_MODE', 'api_key').toLowerCase() as InboundAuthMode;
  if (!INBOUND_AUTH_MODES.includes(raw)) {
    throw new Error(
      `RESELLER_AUTH_MODE must be one of: ${INBOUND_AUTH_MODES.join(', ')} (received "${raw}")`,
    );
  }
  return raw;
}

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  databasePath: string;
  enableDebugEndpoints: boolean;
  publicBaseUrl: string;

  /** 1. WeAreDA -> Reseller */
  inbound: {
    mode: InboundAuthMode;
    apiKey: string;
    customHeader: string;
    basicUser: string;
    basicPassword: string;
  };

  /** 2. Reseller -> WeAreDA webhook */
  webhook: {
    url: string;
    secret: string;
    timeoutMs: number;
    maxAttempts: number;
  };

  /** 3. Reseller -> WeAreDA management / read API */
  managementApi: {
    baseUrl: string;
    resellerKey: string;
    tenantId: string;
  };

  /**
   * Integration settings (contract 1.1, 2, 6.1), split by SCOPE exactly as the
   * API is. `integration:create` sends the reseller-wide ones and
   * `integration:attach` the per-tenant ones; both are mirrored here so the
   * sandbox behaves the way the registration says it will.
   */
  integration: {
    /** INTEGRATION scope. Which of your integrations these calls address. */
    provider: string;
    /** INTEGRATION scope. Governs which calls WeAreDA makes to us. */
    mode: IntegrationMode;
    /** INTEGRATION scope. Who owns the connector credential (contract 2). */
    credentialScope: CredentialScope;
    /** TENANT scope. Your own id for this customer, if you have one. */
    externalTenantId: string;
    /**
     * TENANT scope. Whether an inbound order.status may move the
     * CUSTOMER-FACING orders.status, not just integration_status.
     *
     * On the wire this must be a strict boolean - the string "true" is a 400.
     * Here it is an environment variable, so it is parsed leniently like every
     * other flag; the strictness lives in validateAttachBody().
     */
    orderStatusWrite: boolean;
  };
}

export function loadConfig(): AppConfig {
  const port = int('PORT', 3000);
  return {
    port,
    host: str('HOST', '0.0.0.0'),
    logLevel: str('LOG_LEVEL', 'debug'),
    databasePath: str('DATABASE_PATH', 'var/sandbox.db'),
    enableDebugEndpoints: bool('ENABLE_DEBUG_ENDPOINTS', true),
    publicBaseUrl: str('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
    inbound: {
      mode: authMode(),
      apiKey: str('RESELLER_API_KEY', 'demo_secret'),
      customHeader: str('RESELLER_AUTH_HEADER', 'X-API-Key'),
      basicUser: str('RESELLER_BASIC_USER', 'weareda'),
      basicPassword: str('RESELLER_BASIC_PASSWORD', 'demo_secret'),
    },
    webhook: {
      url: str('WEAREDA_WEBHOOK_URL'),
      secret: str('WEAREDA_WEBHOOK_SECRET'),
      timeoutMs: int('WEAREDA_WEBHOOK_TIMEOUT_MS', 15_000),
      maxAttempts: int('WEAREDA_WEBHOOK_MAX_ATTEMPTS', 3),
    },
    managementApi: {
      baseUrl: str('WEAREDA_API_BASE_URL').replace(/\/+$/, ''),
      resellerKey: str('WEAREDA_RESELLER_KEY'),
      tenantId: str('WEAREDA_TENANT_ID'),
    },
    integration: {
      provider: str('INTEGRATION_PROVIDER', 'generic_http'),
      mode: integrationMode(),
      credentialScope: credentialScope(),
      externalTenantId: str('EXTERNAL_TENANT_ID'),
      orderStatusWrite: bool('ORDER_STATUS_WRITE', false),
    },
  };
}

/** Does this mode expose `GET /` and `GET /products`? */
export function readCallsEnabled(config: AppConfig): boolean {
  return modeReads(config.integration.mode);
}

/** Does this mode receive `POST /orders` and the cancel paths? */
export function orderDeliveryEnabled(config: AppConfig): boolean {
  return modeDeliversOrders(config.integration.mode);
}

/** Derived from the mode - never configured directly. */
export function productsSyncMode(config: AppConfig): 'pull' | 'push' {
  return productsSyncModeFor(config.integration.mode);
}

/** Base URL that WeAreDA should be able to reach (tunnel URL when configured). */
export function publicBaseUrl(config: AppConfig): string {
  return config.publicBaseUrl || `http://localhost:${config.port}`;
}
