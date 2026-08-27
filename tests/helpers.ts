/**
 * Test helpers.
 *
 * Every test file gets its own SQLite file under var/test/, so files can run in
 * parallel without sharing orders or stock.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import { buildServer, type SandboxServer } from '../src/server.js';

export const TEST_API_KEY = 'test_api_key_value';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    port: 0,
    logLevel: 'silent',
    enableDebugEndpoints: true,
    publicBaseUrl: 'https://sandbox.example.test',
    ...overrides,
    inbound: {
      ...base.inbound,
      mode: 'api_key',
      apiKey: TEST_API_KEY,
      ...(overrides.inbound ?? {}),
    },
    webhook: {
      ...base.webhook,
      url: '',
      secret: 'whsec_test_secret',
      maxAttempts: 2,
      timeoutMs: 3000,
      ...(overrides.webhook ?? {}),
    },
    managementApi: { ...base.managementApi, ...(overrides.managementApi ?? {}) },
    integration: {
      ...base.integration,
      // The default shape: WeAreDA reads from us AND delivers orders to us.
      mode: 'query_and_send',
      orderStatusWrite: false,
      ...(overrides.integration ?? {}),
    },
  };
}

export interface TestSandbox extends SandboxServer {
  cleanup(): Promise<void>;
}

export function createTestSandbox(overrides: Partial<AppConfig> = {}): TestSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'weareda-sandbox-'));
  const databasePath = join(dir, 'test.db');
  const sandbox = buildServer(testConfig(overrides), { databasePath, quiet: true });

  return {
    ...sandbox,
    async cleanup() {
      await sandbox.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-api-key': TEST_API_KEY, ...extra };
}

/** A contract-shaped order payload (contract 4.3). */
export function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_number: 'ORD-1042',
    currency: 'USD',
    subtotal: 10000,
    discount: 0,
    tax: 0,
    shipping: 500,
    total: 10500,
    notes: 'leave at door',
    shipping_address: { name: 'Ada', line1: '1 Example St', city: 'Example City', country: 'AR' },
    idempotency_key: 'order:6b1e',
    items: [
      {
        sku: 'WIDGET-PRO-S',
        external_product_id: 'P-1002',
        external_variant_id: 'V-2001',
        name: 'Widget Pro',
        variant_name: 'Small / Black',
        quantity: 2,
        unit_price: 5000,
        discount: 0,
        subtotal: 10000,
      },
    ],
    ...overrides,
  };
}
