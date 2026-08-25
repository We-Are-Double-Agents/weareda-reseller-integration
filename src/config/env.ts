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
  };
}

/** Base URL that WeAreDA should be able to reach (tunnel URL when configured). */
export function publicBaseUrl(config: AppConfig): string {
  return config.publicBaseUrl || `http://localhost:${config.port}`;
}
