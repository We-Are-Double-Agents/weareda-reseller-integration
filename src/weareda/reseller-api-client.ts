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
import type { ConnectBody, IntegrationStatusResponse } from './integration-mode.js';

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
  /**
   * Free-text match over the order number, the customer's name/email/phone -
   * and, since 2026-09, their fiscal identifier (contract 11.3).
   */
  search?: string;
  /** Default 25, max 100 (contract 11.3). */
  limit?: number;
  /** Opaque keyset cursor from pagination.nextCursor of the previous page. */
  cursor?: string;
}

/* -------------------------------------------------------------------------- */
/* Order projections (contract 11.3, 11.4)                                     */
/* -------------------------------------------------------------------------- */

/**
 * ============================================================================
 * TWO CONVENTIONS FOR THE SAME DATA - DO NOT SHARE ONE TYPE
 * ============================================================================
 * The order WeAreDA PUSHES to us (contract 4.3, weareda/types.ts) is
 * snake_case: `tax_id`, `first_name`. The order we PULL back from this read
 * API (contract 11) is camelCase: `taxId`, `firstName`.
 *
 * Same data, two conventions, because each side follows its own existing
 * style. They are modelled as separate types on purpose: a shared one would
 * only be right on one of the two planes, and the mismatch would be found at
 * runtime instead of here.
 * ============================================================================
 */
export interface ReadApiTaxId {
  /** A free short token, not an enum - see TaxId in weareda/types.ts. */
  type: string;
  value: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
}

/** 11.3 - the minimal customer of a LIST item. `taxId` is null when unset. */
export interface ReadApiOrderListCustomer {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  taxId?: ReadApiTaxId | null;
}

/** 11.4 - the DETAIL customer adds the split name. Still no contact internals. */
export interface ReadApiOrderDetailCustomer extends ReadApiOrderListCustomer {
  firstName?: string;
  lastName?: string;
}

export interface ReadApiAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface ReadApiOrderListItem {
  id: string;
  tenantId?: string;
  externalOrderId?: string | null;
  orderNumber?: string;
  status?: string;
  integrationStatus?: string;
  currency?: string;
  subtotal?: number;
  discount?: number;
  tax?: number;
  shipping?: number;
  total?: number;
  /** Absent for an order with no contact (contract 4.3). */
  customer?: ReadApiOrderListCustomer;
  itemsCount?: number;
  invoiceCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReadApiOrderList {
  items: ReadApiOrderListItem[];
  pagination?: { nextCursor?: string | null; hasMore?: boolean };
}

export interface ReadApiOrderDetail extends Omit<ReadApiOrderListItem, 'customer'> {
  customer?: ReadApiOrderDetailCustomer;
  billingAddress?: ReadApiAddress;
  shippingAddress?: ReadApiAddress;
  items?: Array<Record<string, unknown>>;
}

export interface ReadApiResponse<T = unknown> {
  url: string;
  method: 'GET' | 'POST';
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

  /* ---------------------------------------------------------------------- */
  /* Integration configuration (contract 1.1, 2, 6.1)                         */
  /* ---------------------------------------------------------------------- */

  /**
   * POST /api/v1/resellers/me/tenants/{tenantId}/integration/connect
   *
   * Registers (or re-registers) the integration. `integrationMode` and
   * `orderStatusWrite` are TOP-LEVEL fields of this body - siblings of
   * `orderDeliveryStatus`, not members of `declaredCapabilities` or
   * `syncConfig`.
   *
   * Omitting either one on a reconnect leaves the stored value unchanged.
   *
   * The response echoes `integrationMode`, `orderDeliveryEnabled` and
   * `productsSyncMode`, so you can confirm what took effect.
   */
  async connect(body: ConnectBody): Promise<ReadApiResponse<IntegrationStatusResponse>> {
    const { tenantId } = this.requireConfig();
    return this.post(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/integration/connect`,
      body,
    ) as Promise<ReadApiResponse<IntegrationStatusResponse>>;
  }

  /** GET /api/v1/resellers/me/tenants/{tenantId}/integration/status */
  async integrationStatus(): Promise<ReadApiResponse<IntegrationStatusResponse>> {
    const { tenantId } = this.requireConfig();
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/integration/status`,
    ) as Promise<ReadApiResponse<IntegrationStatusResponse>>;
  }

  /**
   * POST /api/v1/resellers/me/tenants/{tenantId}/integration/test-connection
   *
   * Asks WeAreDA to call your `GET /`. The connection test IS a read, so in an
   * integrationMode without reads it answers
   * `422 { reason: "read_calls_disabled" }` without calling anything.
   */
  async testConnection(): Promise<ReadApiResponse> {
    const { tenantId } = this.requireConfig();
    return this.post(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/integration/test-connection`,
      {},
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Orders (contract 11)                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * GET /api/v1/resellers/me/tenants/{tenantId}/orders
   *
   * Items carry a minimal `customer` including `taxId` - camelCase here, and
   * `tax_id` on the pushed payload (contract 11.3 vs 4.3).
   */
  async listOrders(filters: OrderListFilters = {}): Promise<ReadApiResponse<ReadApiOrderList>> {
    const { tenantId } = this.requireConfig();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/orders${suffix}`,
    ) as Promise<ReadApiResponse<ReadApiOrderList>>;
  }

  /**
   * GET /api/v1/resellers/me/tenants/{tenantId}/orders/{orderId}
   *
   * The detail customer adds `firstName` / `lastName` and the billing address
   * (contract 11.4).
   */
  async getOrder(orderId: string): Promise<ReadApiResponse<ReadApiOrderDetail>> {
    const { tenantId } = this.requireConfig();
    return this.get(
      `/api/v1/resellers/me/tenants/${encodeURIComponent(tenantId)}/orders/${encodeURIComponent(orderId)}`,
    ) as Promise<ReadApiResponse<ReadApiOrderDetail>>;
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
    return this.request('GET', path);
  }

  private async post(path: string, body: unknown): Promise<ReadApiResponse> {
    return this.request('POST', path, body);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<ReadApiResponse> {
    const { baseUrl, resellerKey } = this.requireConfig();
    const url = `${baseUrl}${path}`;

    const headers: Record<string, string> = {
      // The third authentication mechanism of this integration.
      'X-Reseller-Key': resellerKey,
      Accept: 'application/json',
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
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
      method,
      statusCode: response.status,
      statusText: response.statusText,
      ok: response.ok,
      body,
    };
  }
}
