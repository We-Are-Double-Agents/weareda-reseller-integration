/**
 * Reseller read API client - contract 11.
 *
 * ============================================================================
 * A DIFFERENT PLANE FROM THE CONNECTOR CONTRACT
 * ============================================================================
 * Sections 4-6 of the contract are the connector: WeAreDA calls your commerce
 * system, and you call the HMAC-signed webhook. THIS file is neither.
 *
 * It is a management/read API that lives on WeAreDA's backend and that you call
 * to inspect the orders of one of your tenants. It authenticates with a plain
 * key header:
 *
 *     X-Reseller-Key: rsk_...
 *
 * NOT with the webhook HMAC signature, and never with X-Tenant-Id - the tenant
 * is taken from the path and must belong to you.
 * ============================================================================
 */
import type { AppConfig } from '../config/env.js';

export interface OrderListFilters {
  status?: string;
  paymentStatus?: string;
  integrationStatus?: string;
  externalOrderId?: string;
  customerId?: string;
  email?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  hasInvoice?: boolean;
  search?: string;
  /** Default 25, max 100 (contract 11.3). */
  limit?: number;
  /** Opaque keyset cursor from pagination.nextCursor of the previous page. */
  cursor?: string;
}

export interface ReadApiResponse<T = unknown> {
  url: string;
  method: 'GET';
  statusCode: number;
  statusText: string;
  ok: boolean;
  body: T;
}

export class ReadApiConfigurationError extends Error {}

export class WeAreDAResellerApiClient {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    const { baseUrl, resellerKey, tenantId } = this.config.managementApi;
    return Boolean(baseUrl && resellerKey && tenantId);
  }

  private requireConfig(): { baseUrl: string; resellerKey: string; tenantId: string } {
    const { baseUrl, resellerKey, tenantId } = this.config.managementApi;
    const missing = [
      baseUrl ? null : 'WEAREDA_API_BASE_URL',
      resellerKey ? null : 'WEAREDA_RESELLER_KEY',
      tenantId ? null : 'WEAREDA_TENANT_ID',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ReadApiConfigurationError(
        `The reseller read API needs ${missing.join(', ')} in your .env. ` +
          'This is the X-Reseller-Key plane (contract 11), not the webhook plane.',
      );
    }
    return { baseUrl, resellerKey, tenantId };
  }

  /** GET /api/v1/resellers/me/tenants/{tenantId}/orders */
  async listOrders(filters: OrderListFilters = {}): Promise<ReadApiResponse> {
    const { tenantId } = this.requireConfig();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.get(`/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/orders${suffix}`);
  }

  /** GET /api/v1/resellers/me/tenants/{tenantId}/orders/{orderId} */
  async getOrder(orderId: string): Promise<ReadApiResponse> {
    const { tenantId } = this.requireConfig();
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/orders/${encodeURIComponent(orderId)}`,
    );
  }

  /** GET /api/v1/resellers/me/tenants/{tenantId}/orders/{orderId}/invoices */
  async listOrderInvoices(orderId: string): Promise<ReadApiResponse> {
    const { tenantId } = this.requireConfig();
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/orders/${encodeURIComponent(orderId)}/invoices`,
    );
  }

  /**
   * GET /api/v1/resellers/me/tenants/{tenantId}/invoices/{invoiceId}/document
   *
   * Returns a SHORT-LIVED presigned URL, not the file and not a permanent link:
   *   { "document_url": "https://...", "kind": "stored", "mime": "application/pdf" }
   */
  async getInvoiceDocument(invoiceId: string): Promise<ReadApiResponse> {
    const { tenantId } = this.requireConfig();
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/invoices/${encodeURIComponent(invoiceId)}/document`,
    );
  }

  private async get(path: string): Promise<ReadApiResponse> {
    const { baseUrl, resellerKey } = this.requireConfig();
    const url = `${baseUrl}${path}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        // The third authentication mechanism of this integration.
        'X-Reseller-Key': resellerKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.config.webhook.timeoutMs),
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      url,
      method: 'GET',
      statusCode: response.status,
      statusText: response.statusText,
      ok: response.ok,
      body,
    };
  }
}
