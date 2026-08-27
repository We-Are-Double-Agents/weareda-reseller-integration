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

    // Contract 2 - the integration configuration endpoints, on the same
    // X-Reseller-Key plane as the read API.
    backend.post('/api/v1/resellers/me/tenants/:tenantId/integration/connect', async (request) => {
      const body = request.body as Record<string, unknown>;
      calls[calls.length - 1]!.body = body;
      const mode = (body.integrationMode as string) ?? 'query_and_send';
      return {
        status: 'connected',
        integrationMode: mode,
        orderDeliveryEnabled: mode === 'query_and_send' || mode === 'receive_and_send',
        productsSyncMode: mode.startsWith('query') ? 'pull' : 'push',
        orderStatusWrite: body.orderStatusWrite === true,
      };
    });

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

    backend.get('/api/v1/resellers/me/tenants/:tenantId/orders', async () => ({
      items: [
        {
          id: 'order-uuid',
          tenantId: 'tenant-uuid',
          externalOrderId: 'SO-10001',
          status: 'confirmed',
          integrationStatus: 'completed',
          total: 12100,
        },
      ],
      pagination: { nextCursor: 'eyJ0ZXN0IjoxfQ', hasMore: true },
    }));

    backend.get('/api/v1/resellers/me/tenants/:tenantId/orders/:orderId', async (request) => ({
      id: (request.params as { orderId: string }).orderId,
      integrationStatus: 'completed',
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

  it('registers the integration with the two new fields at the TOP LEVEL', async () => {
    const response = await client().connect({
      provider: 'generic_http',
      baseUrl: 'https://api.your-erp.com/v1',
      orderDeliveryStatus: 'confirmed',
      integrationMode: 'receive_and_send',
      orderStatusWrite: true,
    });

    expect(response.method).toBe('POST');
    expect(calls[0]?.url).toContain('/tenants/TENANT_ID/integration/connect');
    // Same plane as the read API: X-Reseller-Key, never the webhook HMAC.
    expect(calls[0]?.resellerKey).toBe(RESELLER_KEY);
    expect(calls[0]?.signature).toBeUndefined();

    const sent = calls[0]?.body as Record<string, unknown>;
    expect(sent.integrationMode).toBe('receive_and_send');
    expect(sent.orderStatusWrite).toBe(true);
    // NOT nested anywhere.
    expect(sent.declaredCapabilities).toBeUndefined();
    expect(sent.syncConfig).toBeUndefined();

    expect(response.body).toMatchObject({
      integrationMode: 'receive_and_send',
      orderDeliveryEnabled: true,
      productsSyncMode: 'push',
      orderStatusWrite: true,
    });
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
    expect((response.body as any).items).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/v1/resellers/me/tenants/TENANT_ID/orders');
    expect(calls[0]?.url).toContain('status=confirmed');
    expect(calls[0]?.url).toContain('limit=25');
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
    expect((response.body as any).id).toBe('order-uuid');
    expect((response.body as any).items).toHaveLength(1);
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
