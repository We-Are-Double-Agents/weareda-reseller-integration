/**
 * Reseller read API client - contract 11.
 * Direction: Reseller -> WeAreDA management API.
 *
 * The point of these tests is the AUTHENTICATION PLANE: this API uses
 * X-Reseller-Key, never the connector credentials and never the webhook HMAC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ReadApiConfigurationError,
  WeAreDAResellerApiClient,
  type ReadApiOrderDetail,
  type ReadApiOrderList,
} from '../src/weareda/reseller-api-client.js';
import { testConfig } from './helpers.js';

const RESELLER_KEY = 'rsk_example';
const TENANT_ID = 'TENANT_ID';

interface Call {
  url: string;
  method: string;
  body?: unknown;
  resellerKey: string | undefined;
  signature: string | undefined;
  apiKey: string | undefined;
  tenantHeader: string | undefined;
}

describe('reseller read API client (Reseller -> WeAreDA management API)', () => {
  let backend: FastifyInstance;
  let baseUrl: string;
  let calls: Call[] = [];

  beforeAll(async () => {
    backend = Fastify({ logger: false });

    backend.addHook('onRequest', async (request, reply) => {
      calls.push({
        url: request.url,
        method: request.method,
        resellerKey: request.headers['x-reseller-key'] as string | undefined,
        signature: request.headers['x-weareda-signature'] as string | undefined,
        apiKey: request.headers['x-api-key'] as string | undefined,
        tenantHeader: request.headers['x-tenant-id'] as string | undefined,
      });
      if (request.headers['x-reseller-key'] !== RESELLER_KEY) {
        return reply.code(401).send({ reason: 'invalid_reseller_key' });
      }
    });

    // Contract 2 - the configuration endpoints, in their TWO SCOPES, on the
    // same X-Reseller-Key plane as the read API.
    backend.post('/api/v1/resellers/me/integrations', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      calls[calls.length - 1]!.body = body;
      const mode = (body.integrationMode as string) ?? 'query_and_send';
      return reply.code(201).send({
        provider: body.provider,
        baseUrl: body.baseUrl,
        credentialScope: body.credentialScope ?? 'reseller',
        integrationMode: mode,
        orderDeliveryEnabled: mode === 'query_and_send' || mode === 'receive_and_send',
        productsSyncMode: mode.startsWith('query') ? 'pull' : 'push',
      });
    });

    backend.get('/api/v1/resellers/me/integrations', async () => ({
      integrations: [{ provider: 'generic_http', connectedTenants: [{ tenantId: 'tenant-uuid' }] }],
    }));

    backend.get('/api/v1/resellers/me/integrations/:provider', async (request) => ({
      provider: (request.params as { provider: string }).provider,
      integrationMode: 'receive_and_send',
      syncConfig: { frequency: 'daily', orders: { requiresTaxId: true } },
    }));

    backend.patch('/api/v1/resellers/me/integrations/:provider', async (request) => {
      calls[calls.length - 1]!.body = request.body;
      return {
        provider: (request.params as { provider: string }).provider,
        integrationMode: 'receive_and_send',
        // The blast radius comes back in the response, not only in the docs.
        affectedTenants: 3,
        schedulesReconciled: 3,
      };
    });

    backend.put('/api/v1/resellers/me/integrations/:provider/credentials', async (request) => {
      calls[calls.length - 1]!.body = request.body;
      return { rotated: 'credentials' };
    });

    backend.put('/api/v1/resellers/me/integrations/:provider/webhook-secret', async (request) => {
      calls[calls.length - 1]!.body = request.body;
      return { rotated: 'webhookSecret' };
    });

    backend.post('/api/v1/resellers/me/tenants/:tenantId/integration/attach', async (request) => {
      const body = request.body as Record<string, unknown>;
      calls[calls.length - 1]!.body = body;
      return {
        status: 'connected',
        provider: body.provider,
        webhookUrl: 'https://api.weareda.test/api/v1/reseller-webhooks/conn_1',
        integrationMode: 'receive_and_send',
        orderDeliveryEnabled: true,
        productsSyncMode: 'push',
        orderStatusWrite: body.orderStatusWrite === true,
        externalTenantId: body.externalTenantId ?? null,
      };
    });

    backend.post('/api/v1/resellers/me/tenants/:tenantId/integration/disconnect', async () => ({
      status: 'disconnected',
    }));

    // The one breaking change: the old path answers 410 and names its
    // replacements (contract 2.3, 9).
    backend.post(
      '/api/v1/resellers/me/tenants/:tenantId/integration/connect',
      async (_request, reply) =>
        reply.code(410).send({
          error: 'endpoint_removed',
          replacements: [
            'POST /api/v1/resellers/me/integrations',
            'POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach',
          ],
        }),
    );

    backend.get('/api/v1/resellers/me/tenants/:tenantId/integration/status', async () => ({
      status: 'connected',
      integrationMode: 'receive_and_send',
      orderDeliveryEnabled: true,
      productsSyncMode: 'push',
      orderStatusWrite: false,
    }));

    backend.post(
      '/api/v1/resellers/me/tenants/:tenantId/integration/test-connection',
      async (_request, reply) =>
        // The connection test IS a read, and this integration makes none.
        reply
          .code(422)
          .send({ error: 'test_connection_unavailable', reason: 'read_calls_disabled' }),
    );

    // Contract 11.3: the list customer is minimal, and camelCase - `taxId`,
    // not the `tax_id` of the pushed payload. The second item has no customer
    // at all, which is an ordinary order.
    backend.get('/api/v1/resellers/me/tenants/:tenantId/orders', async () => ({
      items: [
        {
          id: 'order-uuid',
          tenantId: 'tenant-uuid',
          externalOrderId: 'SO-10001',
          status: 'confirmed',
          integrationStatus: 'completed',
          total: 12100,
          customer: {
            id: 'customer-uuid',
            name: 'Juan Perez',
            email: 'juan@example.test',
            phone: '+541100000000',
            taxId: { type: 'CUIT', value: '20-12345678-9', country: 'AR' },
          },
        },
        {
          id: 'order-uuid-2',
          externalOrderId: 'SO-10002',
          total: 5000,
          customer: {
            id: 'customer-uuid-2',
            name: 'No Fiscal Id',
            // Null, not absent: the contact simply has none (contract 4.3).
            taxId: null,
          },
        },
      ],
      pagination: { nextCursor: 'eyJ0ZXN0IjoxfQ', hasMore: true },
    }));

    // Contract 11.4: the detail customer adds firstName / lastName, and the
    // type token is whatever the country uses - here Iceland's.
    backend.get('/api/v1/resellers/me/tenants/:tenantId/orders/:orderId', async (request) => ({
      id: (request.params as { orderId: string }).orderId,
      integrationStatus: 'completed',
      customer: {
        id: 'customer-uuid',
        firstName: 'Juan',
        lastName: 'Perez',
        name: 'Juan Perez',
        email: 'juan@example.test',
        phone: '+541100000000',
        taxId: { type: 'KENNITALA', value: '120174-3389', country: 'IS' },
      },
      billingAddress: { line1: '1 Example St', city: 'Example City', country: 'AR' },
      items: [{ sku: 'SKU-123', quantity: 2 }],
    }));

    backend.get('/api/v1/resellers/me/tenants/:tenantId/orders/:orderId/invoices', async () => [
      { id: 'invoice-uuid', externalInvoiceId: 'INV-1', documentAvailable: true },
    ]);

    backend.get(
      '/api/v1/resellers/me/tenants/:tenantId/invoices/:invoiceId/document',
      async () => ({
        document_url: 'https://files.example.com/presigned',
        kind: 'stored',
        mime: 'application/pdf',
      }),
    );

    await backend.listen({ port: 0, host: '127.0.0.1' });
    const address = backend.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await backend.close();
  });

  beforeEach(() => {
    calls = [];
  });

  function client(overrides: Record<string, string> = {}) {
    return new WeAreDAResellerApiClient(
      testConfig({
        managementApi: { baseUrl, resellerKey: RESELLER_KEY, tenantId: TENANT_ID, ...overrides },
      } as never),
    );
  }

  it('creates the integration at INTEGRATION scope - no per-tenant field in the body', async () => {
    const response = await client().createIntegration({
      provider: 'generic_http',
      baseUrl: 'https://api.your-erp.com/v1',
      authType: 'api_key',
      credentialScope: 'reseller',
      externalCredentials: { apiKey: 'sk_live_x' },
      integrationMode: 'receive_and_send',
    });

    expect(response.method).toBe('POST');
    expect(response.statusCode).toBe(201);
    // Reseller-wide, so NOT under /tenants/{tenantId}.
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/integrations');
    expect(calls[0]?.url).not.toContain('/tenants/');
    // Same plane as the read API: X-Reseller-Key, never the webhook HMAC.
    expect(calls[0]?.resellerKey).toBe(RESELLER_KEY);
    expect(calls[0]?.signature).toBeUndefined();

    const sent = calls[0]?.body as Record<string, unknown>;
    expect(sent.integrationMode).toBe('receive_and_send');
    expect(sent.credentialScope).toBe('reseller');
    // Per-tenant settings have no business here.
    expect(sent.orderStatusWrite).toBeUndefined();
    expect(sent.orderDeliveryStatus).toBeUndefined();

    expect(response.body).toMatchObject({
      integrationMode: 'receive_and_send',
      orderDeliveryEnabled: true,
      productsSyncMode: 'push',
    });
  });

  it("attaches one customer at TENANT scope, and gets that customer's webhookUrl", async () => {
    const response = await client().attachTenant({
      provider: 'generic_http',
      orderDeliveryStatus: 'confirmed',
      orderStatusWrite: true,
      externalTenantId: 'cust-7',
    });

    expect(calls[0]?.url).toBe('/api/v1/resellers/me/tenants/TENANT_ID/integration/attach');
    const sent = calls[0]?.body as Record<string, unknown>;
    expect(sent.orderStatusWrite).toBe(true);
    // Nothing reseller-wide travels in an attach body.
    expect(sent.baseUrl).toBeUndefined();
    expect(sent.integrationMode).toBeUndefined();
    expect(sent.syncConfig).toBeUndefined();

    expect(response.body).toMatchObject({
      status: 'connected',
      orderStatusWrite: true,
      externalTenantId: 'cust-7',
    });
    expect(response.body.webhookUrl).toContain('/api/v1/reseller-webhooks/');
  });

  it('lists integrations with the customers attached to each', async () => {
    const response = await client().listIntegrations();
    expect(calls[0]?.method).toBe('GET');
    expect(response.body).toMatchObject({
      integrations: [{ provider: 'generic_http', connectedTenants: [{ tenantId: 'tenant-uuid' }] }],
    });
  });

  it('reads the stored syncConfig back before patching it (7.1)', async () => {
    const response = await client().getIntegration('generic_http');
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/integrations/generic_http');
    expect(response.body.syncConfig).toMatchObject({ orders: { requiresTaxId: true } });
  });

  it('patches the integration and reports the blast radius', async () => {
    const response = await client().patchIntegration('generic_http', {
      syncConfig: { documentHosts: ['files.your-erp.com', 'cdn.your-erp.com'] },
    });

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/integrations/generic_http');
    // affectedTenants / schedulesReconciled are in the RESPONSE, not only in
    // the documentation (contract 2.3).
    expect(response.body).toMatchObject({ affectedTenants: 3, schedulesReconciled: 3 });
  });

  it('rotates the credential and the signing secret through their own PUTs', async () => {
    const credentials = await client().rotateCredentials('generic_http', { apiKey: 'sk_live_new' });
    expect(credentials.method).toBe('PUT');
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/integrations/generic_http/credentials');
    expect(calls[0]?.body).toMatchObject({ externalCredentials: { apiKey: 'sk_live_new' } });

    calls = [];
    const secret = await client().rotateWebhookSecret('generic_http', 'whsec_new');
    expect(secret.method).toBe('PUT');
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/integrations/generic_http/webhook-secret');
    expect(calls[0]?.body).toMatchObject({ webhookSecret: 'whsec_new' });
  });

  it('detaches one customer without touching the integration', async () => {
    const response = await client().disconnectTenant();
    expect(calls[0]?.url).toBe('/api/v1/resellers/me/tenants/TENANT_ID/integration/disconnect');
    expect(response.body).toMatchObject({ status: 'disconnected' });
  });

  it('refuses the removed connect locally, naming its two replacements', () => {
    // The endpoint answers 410; the client does not even make the round trip.
    expect(() => client().connect()).toThrow(/integration\/connect was removed/);
    expect(() => client().connect()).toThrow(/POST \/api\/v1\/resellers\/me\/integrations/);
    expect(calls).toHaveLength(0);
  });

  it('echoes the mode from GET .../integration/status', async () => {
    const response = await client().integrationStatus();
    expect(calls[0]?.method).toBe('GET');
    expect(response.body).toMatchObject({
      integrationMode: 'receive_and_send',
      orderDeliveryEnabled: true,
      productsSyncMode: 'push',
    });
  });

  it('gets 422 read_calls_disabled from test-connection when the mode makes no reads', async () => {
    const response = await client().testConnection();
    expect(response.statusCode).toBe(422);
    expect((response.body as any).reason).toBe('read_calls_disabled');
  });

  it('lists tenant orders', async () => {
    const response = await client().listOrders({ status: 'confirmed', limit: 25 });
    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(calls[0]?.url).toContain('/api/v1/resellers/me/tenants/TENANT_ID/orders');
    expect(calls[0]?.url).toContain('status=confirmed');
    expect(calls[0]?.url).toContain('limit=25');
  });

  /* ---------------------------------------------------------------------- */
  /* customer.taxId - camelCase on this plane (contract 11.3, 11.4)           */
  /* ---------------------------------------------------------------------- */

  it('parses customer.taxId on a list response - camelCase, not tax_id', async () => {
    const response = await client().listOrders();
    const body: ReadApiOrderList = response.body;

    const [withTaxId, withoutTaxId] = body.items;
    expect(withTaxId?.customer?.name).toBe('Juan Perez');
    expect(withTaxId?.customer?.taxId).toEqual({
      type: 'CUIT',
      value: '20-12345678-9',
      country: 'AR',
    });
    // `null` means the contact has no fiscal id. It is not an error, and not
    // the same as the whole customer being absent.
    expect(withoutTaxId?.customer?.taxId).toBeNull();
    // The pushed payload's spelling must NOT appear on this plane.
    expect((withTaxId?.customer as Record<string, unknown>).tax_id).toBeUndefined();
  });

  it('parses the detail customer, including an unknown taxId.type', async () => {
    const response = await client().getOrder('order-uuid');
    const body: ReadApiOrderDetail = response.body;

    expect(body.customer?.firstName).toBe('Juan');
    expect(body.customer?.lastName).toBe('Perez');
    // Free token: a type nobody here has heard of parses exactly like CUIT.
    expect(body.customer?.taxId?.type).toBe('KENNITALA');
    expect(body.customer?.taxId?.country).toBe('IS');
    expect(body.billingAddress?.city).toBe('Example City');
  });

  it('passes a tax id through the search filter (contract 11.3)', async () => {
    await client().listOrders({ search: '20-12345678-9' });
    expect(calls[0]?.url).toContain('search=20-12345678-9');
  });

  it('authenticates with X-Reseller-Key and nothing else', async () => {
    await client().listOrders();
    const call = calls[0]!;
    expect(call.resellerKey).toBe(RESELLER_KEY);
    // Explicitly NOT the other two planes.
    expect(call.signature).toBeUndefined();
    expect(call.apiKey).toBeUndefined();
    // Contract 11: the tenant comes from the path, never from X-Tenant-Id.
    expect(call.tenantHeader).toBeUndefined();
  });

  it('returns 401 invalid_reseller_key when the key is wrong', async () => {
    const response = await client({ resellerKey: 'rsk_wrong' }).listOrders();
    expect(response.statusCode).toBe(401);
    expect((response.body as any).reason).toBe('invalid_reseller_key');
  });

  it('passes the opaque keyset cursor back verbatim', async () => {
    await client().listOrders({ cursor: 'eyJ0ZXN0IjoxfQ', status: 'confirmed' });
    expect(calls[0]?.url).toContain('cursor=eyJ0ZXN0IjoxfQ');
    expect(calls[0]?.url).toContain('status=confirmed'); // filters resent with the cursor
  });

  it('fetches one order detail', async () => {
    const response = await client().getOrder('order-uuid');
    expect(response.body.id).toBe('order-uuid');
    expect(response.body.items).toHaveLength(1);
  });

  it('fetches the invoices of an order', async () => {
    const response = await client().listOrderInvoices('order-uuid');
    expect(Array.isArray(response.body)).toBe(true);
  });

  it('fetches a short-lived presigned invoice document URL', async () => {
    const response = await client().getInvoiceDocument('invoice-uuid');
    expect((response.body as any).document_url).toMatch(/^https:\/\//);
    expect((response.body as any).mime).toBe('application/pdf');
  });

  it('url-encodes path parameters', async () => {
    await client().getOrder('weird id/../x');
    expect(calls[0]?.url).toContain('weird%20id%2F..%2Fx');
  });

  it('explains which variables are missing rather than calling a broken URL', async () => {
    const unconfigured = new WeAreDAResellerApiClient(
      testConfig({ managementApi: { baseUrl: '', resellerKey: '', tenantId: '' } } as never),
    );
    await expect(unconfigured.listOrders()).rejects.toThrow(ReadApiConfigurationError);
    await expect(unconfigured.listOrders()).rejects.toThrow(/WEAREDA_API_BASE_URL/);
    expect(calls).toHaveLength(0);
  });
});
