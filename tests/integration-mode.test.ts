/**
 * integrationMode, orderStatusWrite and the TWO SCOPES - contract 1.1, 2, 6.1
 * and 7.1.
 *
 * Four things are asserted here:
 *   1. the four modes and what each one derives,
 *   2. the two scopes: what each body accepts, and that a field of the OTHER
 *      scope is a 400 that names where it belongs - the mistake the removed
 *      `connect` made silently,
 *   3. the syncConfig whitelist and the PATCH merge of 7.1,
 *   4. that the sandbox really registers only the routes its mode receives -
 *      a receive_only reseller answers 404, it does not merely say it would.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_SUPPORT,
  DECLARED_CAPABILITY_KEYS,
  INTEGRATION_MODES,
  REMOVED_CONNECT_ENDPOINT,
  computeEffectiveCapabilities,
  mergeSyncConfig,
  modeDeliversOrders,
  modeReads,
  productsSyncModeFor,
  resolveIntegrationMode,
  validateAttachBody,
  validateCreateIntegrationBody,
  validatePatchIntegrationBody,
  type AttachTenantBody,
  type CreateIntegrationBody,
  type IntegrationMode,
  type StoredIntegration,
} from '../src/weareda/integration-mode.js';
import { orderDeliveryEnabled, readCallsEnabled } from '../src/config/env.js';
import { authHeaders, createTestSandbox, orderPayload, testConfig } from './helpers.js';

/** A valid INTEGRATION body (contract 2.1) - reseller-wide, no tenant field. */
function createBody(overrides: Partial<CreateIntegrationBody> = {}): CreateIntegrationBody {
  return {
    provider: 'generic_http',
    baseUrl: 'https://api.your-erp.com/v1',
    authType: 'api_key',
    credentialScope: 'reseller',
    externalCredentials: { apiKey: 'sk_live_x' },
    webhookSecret: 'whsec_example',
    ...overrides,
  };
}

/** A valid TENANT body (contract 2.2) - this customer, and no other. */
function attachBody(overrides: Partial<AttachTenantBody> = {}): AttachTenantBody {
  return { provider: 'generic_http', orderDeliveryStatus: 'confirmed', ...overrides };
}

/** The integration a customer is being attached to. */
function storedIntegration(overrides: Partial<StoredIntegration> = {}): StoredIntegration {
  return {
    provider: 'generic_http',
    integrationMode: 'query_and_send',
    credentialScope: 'reseller',
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

  it('leaves the stored value unchanged when the field is omitted on a patch', () => {
    expect(resolveIntegrationMode({ stored: 'query_only' })).toBe('query_only');
    expect(resolveIntegrationMode({ requested: 'receive_only', stored: 'query_only' })).toBe(
      'receive_only',
    );
  });
});

describe('the integration body (contract 2.1) - reseller scope', () => {
  it('accepts the minimal body and derives everything else', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({ integrationMode: 'receive_and_send' }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe('receive_and_send');
    expect(verdict.productsSyncMode).toBe('push');
    expect(verdict.orderDeliveryEnabled).toBe(true);
    expect(verdict.credentialScope).toBe('reseller');
  });

  it('is a create, not an upsert: a second one for the same provider is 409', () => {
    const verdict = validateCreateIntegrationBody(createBody(), storedIntegration());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toMatchObject({ status: 409, error: 'integration_exists' });
    // Which is the whole point: it can never overwrite what the other
    // customers are running on.
    expect(verdict.errors[0]?.message).toContain('PATCH');
  });

  it('requires a baseUrl even in receive_only - it is registered, not called', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({ integrationMode: 'receive_only', baseUrl: '' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
    expect(verdict.errors[0]?.message).toContain('receive_only');
  });

  it('rejects an unknown integrationMode', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({ integrationMode: 'send_only' as IntegrationMode }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
  });

  /* ------------------------------------------------------------------ */
  /* credentialScope (contract 2)                                        */
  /* ------------------------------------------------------------------ */

  it('requires a credential at reseller scope and refuses one at tenant scope', () => {
    const missing = validateCreateIntegrationBody(
      createBody({ externalCredentials: undefined as never }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]?.message).toContain('required at credentialScope "reseller"');

    // At tenant scope there is no customer yet to own one: it comes at attach.
    const early = validateCreateIntegrationBody(createBody({ credentialScope: 'tenant' }));
    expect(early.ok).toBe(false);
    expect(early.errors[0]?.message).toContain('attach');

    expect(
      validateCreateIntegrationBody(
        createBody({ credentialScope: 'tenant', externalCredentials: undefined as never }),
      ).ok,
    ).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* The scope guard, in both directions                                 */
  /* ------------------------------------------------------------------ */

  it('refuses a per-TENANT field in the integration body, naming where it belongs', () => {
    for (const field of ['orderStatusWrite', 'orderDeliveryStatus', 'externalTenantId']) {
      const verdict = validateCreateIntegrationBody(createBody({ [field]: 'x' }));
      expect(verdict.ok).toBe(false);
      expect(verdict.errors[0]?.error).toBe('invalid_request');
      expect(verdict.errors[0]?.message).toContain('attach');
    }
  });

  it('rejects a products.mode that contradicts the mode, instead of picking a winner', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({
        integrationMode: 'query_and_send',
        syncConfig: { products: { mode: 'push' } },
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
  });

  it('accepts a products.mode that agrees with the derived transport', () => {
    expect(
      validateCreateIntegrationBody(
        createBody({
          integrationMode: 'receive_and_send',
          syncConfig: { products: { mode: 'push' } },
        }),
      ).ok,
    ).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* syncConfig.orders.requiresTaxId (contract 4.3.2, 7)                  */
  /* ------------------------------------------------------------------ */

  it('accepts syncConfig.orders.requiresTaxId as a boolean', () => {
    expect(
      validateCreateIntegrationBody(createBody({ syncConfig: { orders: { requiresTaxId: true } } }))
        .ok,
    ).toBe(true);
    expect(
      validateCreateIntegrationBody(
        createBody({ syncConfig: { orders: { requiresTaxId: false } } }),
      ).ok,
    ).toBe(true);
  });

  it('rejects a non-boolean requiresTaxId as invalid_sync_config', () => {
    // Like orderStatusWrite, the string "true" is not a boolean (contract 7).
    const verdict = validateCreateIntegrationBody(
      createBody({ syncConfig: { orders: { requiresTaxId: 'true' } } as never }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
    expect(verdict.errors[0]?.message).toContain('requiresTaxId must be a boolean');
  });

  it('still rejects an unknown syncConfig.orders option', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({ syncConfig: { orders: { requiresTaxID: true } } as never }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
  });

  /* ------------------------------------------------------------------ */
  /* The rest of the contract-7 table                                    */
  /* ------------------------------------------------------------------ */

  it('enforces the syncConfig value rules, not just its key names', () => {
    const rejects = (syncConfig: unknown) =>
      expect(
        validateCreateIntegrationBody(createBody({ syncConfig: syncConfig as never })).errors[0]
          ?.error,
      ).toBe('invalid_sync_config');

    rejects({ products: { path: 'https://api.your-erp.com/products' } }); // absolute
    rejects({ products: { path: '/products/../admin' } }); // traversal
    rejects({ products: { pageSize: 1000 } }); // 1-500
    rejects({ orders: { idempotencyHeader: 'Idempotency Key' } }); // not a header name
    rejects({ frequency: 'fortnightly' });
    rejects({ scheduleExpression: 'every day' });

    expect(
      validateCreateIntegrationBody(
        createBody({
          syncConfig: {
            products: { path: '/v2/products', pageSize: 200, fieldMap: { id: 'sku_id' } },
            orders: { path: '/sales-orders', idempotencyHeader: 'X-Idempotency-Key' },
            scheduleExpression: 'rate(1 hour)',
          },
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts only BARE hostnames in documentHosts - never a URL, port, or IP literal', () => {
    // An IP literal would allow-list around the SSRF guard (contract 9).
    for (const host of [
      'https://files.your-erp.com',
      'files.your-erp.com:8443',
      'files.your-erp.com/inv',
      '10.0.0.5',
    ]) {
      const verdict = validateCreateIntegrationBody(
        createBody({ syncConfig: { documentHosts: [host] } }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
    }

    expect(
      validateCreateIntegrationBody(
        createBody({ syncConfig: { documentHosts: ['files.your-erp.com', 'cdn.your-erp.com'] } }),
      ).ok,
    ).toBe(true);

    const tooMany = validateCreateIntegrationBody(
      createBody({
        syncConfig: { documentHosts: Array.from({ length: 11 }, (_, i) => `h${i}.your-erp.com`) },
      }),
    );
    expect(tooMany.ok).toBe(false);
  });

  it('rejects the fields nested in declaredCapabilities as invalid_request', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({
        declaredCapabilities: {
          integrationMode: 'query_only',
        } as unknown as Record<string, boolean>,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_request');
    expect(verdict.errors[0]?.message).toContain('TOP-LEVEL');
  });

  it('rejects the fields nested in syncConfig as invalid_sync_config', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({ syncConfig: { orderStatusWrite: true } as never }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
    expect(verdict.errors[0]?.message).toContain('attach');
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
      validateCreateIntegrationBody(
        createBody({ declaredCapabilities: { productsRead: true, invoices: false } }),
      ).ok,
    ).toBe(true);
    expect(
      validateCreateIntegrationBody(
        createBody({ declaredCapabilities: { stockRead: 'yes' as unknown as boolean } }),
      ).ok,
    ).toBe(false);
    expect(
      validateCreateIntegrationBody(createBody({ declaredCapabilities: { orders: true } as never }))
        .ok,
    ).toBe(false);
  });

  it('never lets the declaration enable anything', () => {
    const verdict = validateCreateIntegrationBody(
      createBody({
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
      validateCreateIntegrationBody(createBody({ syncConfig: { frequencies: 'daily' } as never }))
        .ok,
    ).toBe(false);

    // productsSyncMode is a RESPONSE field. Sent as input it is dropped
    // without a word - which is why it is reported as an ignored key here.
    const verdict = validateCreateIntegrationBody(createBody({ productsSyncMode: 'push' }));
    expect(verdict.ok).toBe(true);
    expect(verdict.ignoredKeys).toEqual(['productsSyncMode']);
    expect(verdict.productsSyncMode).toBe('pull');
  });
});

describe('the attach body (contract 2.2) - tenant scope', () => {
  it('accepts the per-tenant fields and takes the mode from the integration', () => {
    const verdict = validateAttachBody(
      attachBody({ orderStatusWrite: true, externalTenantId: 'cust-7' }),
      storedIntegration(),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.orderStatusWrite).toBe(true);
    expect(verdict.externalTenantId).toBe('cust-7');
    // A tenant never chooses the mode: it is reseller-wide.
    expect(verdict.mode).toBe('query_and_send');
  });

  it('refuses an INTEGRATION field, naming where it belongs', () => {
    // This is the removed connect's bug, made loud: attaching one customer
    // must never reconfigure the others.
    for (const [field, value] of [
      ['baseUrl', 'https://other.example.com'],
      ['integrationMode', 'receive_only'],
      ['syncConfig', {}],
      ['credentialScope', 'tenant'],
      ['declaredCapabilities', {}],
      ['webhookSecret', 'whsec_other'],
    ] as const) {
      const verdict = validateAttachBody(
        attachBody({ [field]: value } as never),
        storedIntegration(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.errors[0]?.error).toBe('invalid_request');
      expect(verdict.errors[0]?.message).toMatch(/integrations|webhook-secret/);
    }
  });

  it('rejects orderStatusWrite as a string - it must be a real boolean', () => {
    const verdict = validateAttachBody(
      attachBody({ orderStatusWrite: 'true' as unknown as boolean }),
      storedIntegration(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toMatchObject({ status: 400, error: 'invalid_request' });
  });

  it('rejects orderStatusWrite on a mode that never receives an order', () => {
    const verdict = validateAttachBody(
      attachBody({ orderStatusWrite: true }),
      storedIntegration({ integrationMode: 'query_only' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.message).toContain(
      'orderStatusWrite requires an integrationMode that delivers orders',
    );
    expect(
      validateAttachBody(
        attachBody({ orderStatusWrite: true }),
        storedIntegration({ integrationMode: 'receive_only' }),
      ).ok,
    ).toBe(false);
  });

  it('keeps the two settings independent otherwise', () => {
    // Mode is per reseller (topology); orderStatusWrite is per tenant (data
    // authority). receive_and_send does NOT imply orderStatusWrite.
    expect(
      validateAttachBody(attachBody(), storedIntegration({ integrationMode: 'receive_and_send' }))
        .orderStatusWrite,
    ).toBe(false);
    expect(
      validateAttachBody(
        attachBody({ orderStatusWrite: true }),
        storedIntegration({ integrationMode: 'receive_and_send' }),
      ).ok,
    ).toBe(true);
  });

  it('takes a credential only at credentialScope tenant', () => {
    expect(
      validateAttachBody(
        attachBody({ externalCredentials: { apiKey: 'sk_live_x' } }),
        storedIntegration({ credentialScope: 'reseller' }),
      ).ok,
    ).toBe(false);
    expect(
      validateAttachBody(
        attachBody({ externalCredentials: { apiKey: 'sk_live_x' } }),
        storedIntegration({ credentialScope: 'tenant' }),
      ).ok,
    ).toBe(true);
  });

  it("is idempotent: an omitted field keeps the customer's stored value", () => {
    const stored = { orderStatusWrite: true, orderDeliveryStatus: 'processing' };
    const verdict = validateAttachBody(
      attachBody({ orderDeliveryStatus: undefined }),
      storedIntegration(),
      stored,
    );
    expect(verdict.orderStatusWrite).toBe(true);
    expect(verdict.orderDeliveryStatus).toBe('processing');

    const off = validateAttachBody(
      attachBody({ orderStatusWrite: false }),
      storedIntegration(),
      stored,
    );
    expect(off.orderStatusWrite).toBe(false);
  });

  it('refuses to attach to an integration that does not exist yet', () => {
    const verdict = validateAttachBody(attachBody(), null);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toMatchObject({ status: 404, error: 'integration_not_found' });
  });
});

describe('patching the integration (contract 2.3, 7.1)', () => {
  const stored = storedIntegration({
    syncConfig: {
      products: { path: '/products', pageSize: 200 },
      orders: { requiresTaxId: true },
      frequency: 'daily',
    },
  });

  it('leaves every key it does not name alone', () => {
    const verdict = validatePatchIntegrationBody({ baseUrl: 'https://v2.your-erp.com' }, stored);
    expect(verdict.ok).toBe(true);
    expect(verdict.syncConfig).toEqual(stored.syncConfig);
    expect(verdict.mode).toBe('query_and_send');
  });

  it('REPLACES a named section whole - it is not a deep merge', () => {
    const verdict = validatePatchIntegrationBody(
      { syncConfig: { products: { path: '/v2' } } },
      stored,
    );
    expect(verdict.ok).toBe(true);
    // pageSize is gone: /v2 is now the ENTIRE products section.
    expect(verdict.syncConfig.products).toEqual({ path: '/v2' });
    expect(verdict.syncConfig.orders).toEqual({ requiresTaxId: true });
  });

  it('deletes a key with null, resetting it to its default', () => {
    const verdict = validatePatchIntegrationBody({ syncConfig: { orders: null } }, stored);
    expect(verdict.ok).toBe(true);
    expect(verdict.syncConfig.orders).toBeUndefined();
    expect(verdict.syncConfig.products).toEqual({ path: '/products', pageSize: 200 });
  });

  it('validates the MERGED result by the same rules a create would', () => {
    const verdict = validatePatchIntegrationBody(
      { syncConfig: { documentHosts: ['https://files.your-erp.com'] } },
      stored,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
  });

  it('never lets products.mode be set - integrationMode supersedes it', () => {
    const verdict = validatePatchIntegrationBody(
      { syncConfig: { products: { mode: 'push' } } },
      stored,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.error).toBe('invalid_sync_config');
    expect(verdict.errors[0]?.message).toContain('integrationMode');
  });

  it('refuses to rotate a secret as a side effect of an edit', () => {
    for (const field of ['externalCredentials', 'webhookSecret']) {
      const verdict = validatePatchIntegrationBody({ [field]: { apiKey: 'x' } }, stored);
      expect(verdict.ok).toBe(false);
      expect(verdict.errors[0]?.message).toContain('PUT');
    }
  });

  it('reports the blast radius of a schedule or mode change', () => {
    const tenants = [{ tenantId: 't1' }, { tenantId: 't2' }];

    const hosts = validatePatchIntegrationBody(
      { syncConfig: { documentHosts: ['cdn.your-erp.com'] } },
      stored,
      tenants,
    );
    expect(hosts.affectedTenants).toBe(2);
    // Nothing about the schedule changed, so nothing was reconciled.
    expect(hosts.schedulesReconciled).toBe(0);

    const schedule = validatePatchIntegrationBody(
      { syncConfig: { frequency: 'hourly' } },
      stored,
      tenants,
    );
    expect(schedule.schedulesReconciled).toBe(2);

    const mode = validatePatchIntegrationBody(
      { integrationMode: 'receive_and_send' },
      stored,
      tenants,
    );
    expect(mode.schedulesReconciled).toBe(2);
    expect(mode.productsSyncMode).toBe('push');
  });

  it('refuses a mode change that would strand a tenant with orderStatusWrite', () => {
    const verdict = validatePatchIntegrationBody({ integrationMode: 'query_only' }, stored, [
      { tenantId: 't1', orderStatusWrite: true },
      { tenantId: 't2', orderStatusWrite: false },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]).toMatchObject({ status: 409, error: 'order_status_write_conflict' });
    expect(verdict.errors[0]?.message).toContain('t1');
    expect(verdict.errors[0]?.message).not.toContain('t2');
  });

  it('merges by 7.1 as a standalone rule', () => {
    expect(mergeSyncConfig({ frequency: 'daily' }, undefined)).toEqual({ frequency: 'daily' });
    expect(mergeSyncConfig({ frequency: 'daily', enabled: true }, { enabled: false })).toEqual({
      frequency: 'daily',
      enabled: false,
    });
    expect(mergeSyncConfig({ frequency: 'daily', enabled: true }, { enabled: null })).toEqual({
      frequency: 'daily',
    });
  });
});

describe('the removed connect endpoint (contract 2.3, 9)', () => {
  it('is a 410 that names the two calls replacing it', () => {
    expect(REMOVED_CONNECT_ENDPOINT.status).toBe(410);
    expect(REMOVED_CONNECT_ENDPOINT.error).toBe('endpoint_removed');
    // A new pair of paths, never a redefinition of the same one.
    expect(REMOVED_CONNECT_ENDPOINT.replacements[0]).toContain(
      'POST /api/v1/resellers/me/integrations',
    );
    expect(REMOVED_CONNECT_ENDPOINT.replacements[1]).toContain('/integration/attach');
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
