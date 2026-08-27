/**
 * integrationMode and orderStatusWrite - contract 1.1, 2 and 6.1.
 *
 * Three things are asserted here:
 *   1. the four modes and what each one derives,
 *   2. the connect body's validation, including every documented 400,
 *   3. that the sandbox really registers only the routes its mode receives -
 *      a receive_only reseller answers 404, it does not merely say it would.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_SUPPORT,
  DECLARED_CAPABILITY_KEYS,
  INTEGRATION_MODES,
  computeEffectiveCapabilities,
  modeDeliversOrders,
  modeReads,
  productsSyncModeFor,
  resolveIntegrationMode,
  validateConnectBody,
  type ConnectBody,
  type IntegrationMode,
} from '../src/weareda/integration-mode.js';
import { orderDeliveryEnabled, readCallsEnabled } from '../src/config/env.js';
import { authHeaders, createTestSandbox, orderPayload, testConfig } from './helpers.js';

function connectBody(overrides: Partial<ConnectBody> = {}): ConnectBody {
  return {
    provider: 'generic_http',
    baseUrl: 'https://api.your-erp.com/v1',
    authType: 'api_key',
    externalCredentials: { apiKey: 'sk_live_x' },
    webhookSecret: 'whsec_example',
    orderDeliveryStatus: 'confirmed',
    ...overrides,
  };
}

describe('the four integration shapes', () => {
  it('splits the four outbound calls along two independent axes', () => {
    expect(INTEGRATION_MODES).toEqual([
      'query_and_send',
      'receive_and_send',
      'query_only',
      'receive_only',
    ]);

    const table = INTEGRATION_MODES.map((mode) => [
      mode,
      modeReads(mode),
      modeDeliversOrders(mode),
      productsSyncModeFor(mode),
    ]);

    expect(table).toEqual([
      ['query_and_send', true, true, 'pull'],
      ['receive_and_send', false, true, 'push'],
      ['query_only', true, false, 'pull'],
      ['receive_only', false, false, 'push'],
    ]);
  });

  it('does not treat receive_and_send as "no outbound calls" - orders are still delivered', () => {
    expect(modeReads('receive_and_send')).toBe(false);
    expect(modeDeliversOrders('receive_and_send')).toBe(true);
  });

  it('switches ordersWrite off in the effective capabilities of a mode without delivery', () => {
    expect(computeEffectiveCapabilities('query_and_send').ordersWrite).toBe(true);
    expect(computeEffectiveCapabilities('receive_and_send').ordersWrite).toBe(true);
    expect(computeEffectiveCapabilities('query_only').ordersWrite).toBe(false);
    expect(computeEffectiveCapabilities('receive_only').ordersWrite).toBe(false);
  });

  it('keeps productsRead on without reads - one permission, two transports', () => {
    expect(computeEffectiveCapabilities('receive_only').productsRead).toBe(true);
  });

  it('is capped by connector support and the platform ceiling, never by the declaration', () => {
    // The reseller declared everything; productsWrite is still off, because no
    // generic_http connector supports it.
    expect(CONNECTOR_SUPPORT.productsWrite).toBe(false);
    expect(computeEffectiveCapabilities('query_and_send').productsWrite).toBe(false);

    const ceiling = { ...CONNECTOR_SUPPORT, invoices: false };
    expect(
      computeEffectiveCapabilities('query_and_send', { platformCeiling: ceiling }).invoices,
    ).toBe(false);
  });
});

describe('resolving the mode', () => {
  it('defaults to query_and_send', () => {
    expect(resolveIntegrationMode({})).toBe('query_and_send');
  });

  it('resolves a pre-integrationMode integration with products.mode push to receive_and_send', () => {
    // Back-compat, no data migration: reads off, orders still delivered.
    expect(resolveIntegrationMode({ storedProductsMode: 'push' })).toBe('receive_and_send');
    expect(resolveIntegrationMode({ storedProductsMode: 'pull' })).toBe('query_and_send');
  });

  it('leaves the stored value unchanged when the field is omitted on a reconnect', () => {
    expect(resolveIntegrationMode({ stored: 'query_only' })).toBe('query_only');
    expect(resolveIntegrationMode({ requested: 'receive_only', stored: 'query_only' })).toBe(
      'receive_only',
    );
  });
});

describe('connect body validation', () => {
  it('accepts the minimal body and derives everything else', () => {
    const verdict = validateConnectBody(connectBody({ integrationMode: 'receive_and_send' }));
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe('receive_and_send');
    expect(verdict.productsSyncMode).toBe('push');
    expect(verdict.orderDeliveryEnabled).toBe(true);
    expect(verdict.orderStatusWrite).toBe(false);
  });

  it('requires a baseUrl even in receive_only - it is registered, not called', () => {
    const verdict = validateConnectBody(
      connectBody({ integrationMode: 'receive_only', baseUrl: '' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
    expect(verdict.errors[0]?.message).toContain('receive_only');
  });

  it('rejects an unknown integrationMode', () => {
    const verdict = validateConnectBody(
      connectBody({ integrationMode: 'send_only' as IntegrationMode }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
  });

  it('rejects orderStatusWrite as a string - it must be a real boolean', () => {
    const verdict = validateConnectBody(
      connectBody({ orderStatusWrite: 'true' as unknown as boolean }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toMatchObject({ status: 400, error: 'invalid_request' });
  });

  it('rejects orderStatusWrite on a mode that never receives an order', () => {
    const verdict = validateConnectBody(
      connectBody({ integrationMode: 'query_only', orderStatusWrite: true }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.message).toContain(
      'orderStatusWrite requires an integrationMode that delivers orders',
    );
    expect(
      validateConnectBody(connectBody({ integrationMode: 'receive_only', orderStatusWrite: true }))
        .ok,
    ).toBe(false);
  });

  it('allows the two settings to be chosen independently otherwise', () => {
    // Mode is per reseller (topology); orderStatusWrite is per tenant (data
    // authority). receive_and_send does NOT imply orderStatusWrite.
    expect(
      validateConnectBody(connectBody({ integrationMode: 'receive_and_send' })).orderStatusWrite,
    ).toBe(false);
    expect(
      validateConnectBody(
        connectBody({ integrationMode: 'query_and_send', orderStatusWrite: true }),
      ).ok,
    ).toBe(true);
    expect(
      validateConnectBody(
        connectBody({ integrationMode: 'receive_and_send', orderStatusWrite: true }),
      ).ok,
    ).toBe(true);
  });

  it('rejects a products.mode that contradicts the mode, instead of picking a winner', () => {
    const verdict = validateConnectBody(
      connectBody({
        integrationMode: 'query_and_send',
        syncConfig: { products: { mode: 'push' } },
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
  });

  it('accepts a products.mode that agrees with the derived transport', () => {
    expect(
      validateConnectBody(
        connectBody({
          integrationMode: 'receive_and_send',
          syncConfig: { products: { mode: 'push' } },
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects the two fields nested in declaredCapabilities as invalid_request', () => {
    const verdict = validateConnectBody(
      connectBody({
        declaredCapabilities: {
          integrationMode: 'query_only',
        } as unknown as Record<string, boolean>,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
    expect(verdict.errors[0]?.message).toContain('TOP-LEVEL');
  });

  it('rejects the two fields nested in syncConfig as invalid_sync_config', () => {
    const verdict = validateConnectBody(
      connectBody({ syncConfig: { orderStatusWrite: true } as never }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
  });

  it('accepts only the six capability keys, boolean-valued', () => {
    expect(DECLARED_CAPABILITY_KEYS).toEqual([
      'productsRead',
      'productsWrite',
      'stockRead',
      'stockWebhooks',
      'ordersWrite',
      'invoices',
    ]);
    expect(
      validateConnectBody(
        connectBody({ declaredCapabilities: { productsRead: true, invoices: false } }),
      ).ok,
    ).toBe(true);
    expect(
      validateConnectBody(
        connectBody({ declaredCapabilities: { stockRead: 'yes' as unknown as boolean } }),
      ).ok,
    ).toBe(false);
    expect(
      validateConnectBody(connectBody({ declaredCapabilities: { orders: true } as never })).ok,
    ).toBe(false);
  });

  it('never lets the declaration enable anything', () => {
    const verdict = validateConnectBody(
      connectBody({
        integrationMode: 'query_only',
        declaredCapabilities: { ordersWrite: true, productsWrite: true },
      }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.effectiveCapabilities.ordersWrite).toBe(false);
    expect(verdict.effectiveCapabilities.productsWrite).toBe(false);
  });

  it('rejects unknown keys inside syncConfig, and silently drops them at the top level', () => {
    expect(
      validateConnectBody(connectBody({ syncConfig: { frequencies: 'daily' } as never })).ok,
    ).toBe(false);

    // productsSyncMode is a RESPONSE field. Sent as input it is dropped
    // without a word - which is why it is reported as an ignored key here.
    const verdict = validateConnectBody(connectBody({ productsSyncMode: 'push' }));
    expect(verdict.ok).toBe(true);
    expect(verdict.ignoredKeys).toEqual(['productsSyncMode']);
    expect(verdict.productsSyncMode).toBe('pull');
  });

  it('leaves an omitted field at its stored value on a reconnect', () => {
    const stored = { integrationMode: 'receive_and_send' as const, orderStatusWrite: true };
    const verdict = validateConnectBody(connectBody(), stored);
    expect(verdict.mode).toBe('receive_and_send');
    expect(verdict.orderStatusWrite).toBe(true);

    const off = validateConnectBody(connectBody({ orderStatusWrite: false }), stored);
    expect(off.orderStatusWrite).toBe(false);
  });
});

describe('the sandbox registers only the calls its mode receives', () => {
  const sandboxes: Array<{ cleanup(): Promise<void> }> = [];

  afterEach(async () => {
    for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup();
  });

  function sandboxInMode(mode: IntegrationMode) {
    const base = testConfig();
    const sandbox = createTestSandbox({ integration: { ...base.integration, mode } });
    sandboxes.push(sandbox);
    return sandbox;
  }

  it.each(INTEGRATION_MODES)('exposes the right endpoints in %s', async (mode) => {
    const sandbox = sandboxInMode(mode);
    const reads = readCallsEnabled(sandbox.config);
    const delivery = orderDeliveryEnabled(sandbox.config);

    const health = await sandbox.app.inject({ method: 'GET', url: '/', headers: authHeaders() });
    const products = await sandbox.app.inject({
      method: 'GET',
      url: '/products',
      headers: authHeaders(),
    });
    const order = await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: orderPayload(),
    });

    expect(health.statusCode).toBe(reads ? 200 : 404);
    expect(products.statusCode).toBe(reads ? 200 : 404);
    expect(order.statusCode).toBe(delivery ? 201 : 404);
  });

  it('keeps the unauthenticated liveness probe in every mode', async () => {
    // /healthz is a local convenience, not the contract's connection test.
    const sandbox = sandboxInMode('receive_only');
    const response = await sandbox.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('never queues an order it cannot deliver', async () => {
    const sandbox = sandboxInMode('query_only');
    await sandbox.app.inject({
      method: 'POST',
      url: '/orders',
      headers: authHeaders({ 'content-type': 'application/json' }),
      payload: orderPayload(),
    });
    // Nothing is queued and later refused - there is no order at all.
    expect(sandbox.orders.list()).toHaveLength(0);
  });
});
