/**
 * GET /products - contract 4.2.
 * Direction: WeAreDA -> Reseller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, createTestSandbox, type TestSandbox } from './helpers.js';

describe('GET /products (WeAreDA -> Reseller)', () => {
  let sandbox: TestSandbox;

  beforeAll(() => {
    sandbox = createTestSandbox();
  });

  afterAll(async () => {
    await sandbox.cleanup();
  });

  async function get(url: string) {
    const response = await sandbox.app.inject({ method: 'GET', url, headers: authHeaders() });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it('returns the catalog wrapped under "products"', async () => {
    const { statusCode, body } = await get('/products');
    expect(statusCode).toBe(200);
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThan(0);
  });

  it('returns the contract field shape for a simple product', async () => {
    const { body } = await get('/products');
    const product = body.products.find((p: { id: string }) => p.id === 'P-1001');
    expect(product).toMatchObject({
      id: 'P-1001',
      sku: 'WIDGET-BLK',
      name: 'Black Widget',
      price: 4999,
      compare_at_price: 5999,
      currency: 'USD',
      status: 'active',
      stock: 42,
    });
    expect(Array.isArray(product.images)).toBe(true);
    expect(Array.isArray(product.variants)).toBe(true);
    expect(product.updated_at).toBeTypeOf('string');
  });

  it('returns variants with their own ids, skus, attributes and stock', async () => {
    const { body } = await get('/products');
    const product = body.products.find((p: { id: string }) => p.id === 'P-1002');
    expect(product.variants).toHaveLength(3);
    expect(product.variants[0]).toMatchObject({
      id: 'V-2001',
      sku: 'WIDGET-PRO-S',
      name: 'Small / Black',
      stock: 12,
    });
    expect(product.variants[0].attributes).toEqual({ size: 'S', color: 'black' });
  });

  it('reports zero stock as 0, not as missing (contract 6.2: 0 means sold out)', async () => {
    const { body } = await get('/products');
    const soldOut = body.products.find((p: { id: string }) => p.id === 'P-1003');
    expect(soldOut.stock).toBe(0);
    expect(soldOut).toHaveProperty('stock');

    const soldOutVariant = body.products
      .find((p: { id: string }) => p.id === 'P-1002')
      .variants.find((v: { id: string }) => v.id === 'V-2003');
    expect(soldOutVariant.stock).toBe(0);
  });

  it('includes an archived product in the catalog', async () => {
    const { body } = await get('/products');
    const archived = body.products.find((p: { id: string }) => p.id === 'P-1004');
    expect(archived.status).toBe('archived');
  });

  describe('pagination (WeAreDA pages until a page returns fewer than limit)', () => {
    it('honours page and limit', async () => {
      const page1 = await get('/products?page=1&limit=3');
      const page2 = await get('/products?page=2&limit=3');
      expect(page1.body.products.map((p: { id: string }) => p.id)).toEqual([
        'P-1001',
        'P-1002',
        'P-1003',
      ]);
      expect(page2.body.products.map((p: { id: string }) => p.id)).toEqual([
        'P-1004',
        'P-1005',
        'P-1006',
      ]);
    });

    it('returns fewer than limit on the last page, which is how WeAreDA stops', async () => {
      const total = (await get('/products')).body.total;
      const lastPage = await get(`/products?page=3&limit=3`);
      expect(lastPage.body.products.length).toBeLessThan(3);
      expect(lastPage.body.products.length).toBe(total - 6);
      expect(lastPage.body.has_more).toBe(false);
    });

    it('returns an empty page past the end rather than an error', async () => {
      const beyond = await get('/products?page=99&limit=3');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.body.products).toEqual([]);
    });

    it('does not repeat or drop products across pages', async () => {
      const all = (await get('/products')).body.products.map((p: { id: string }) => p.id);
      const paged: string[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const result = await get(`/products?page=${page}&limit=2`);
        paged.push(...result.body.products.map((p: { id: string }) => p.id));
        if (result.body.products.length < 2) break;
      }
      expect(paged).toEqual(all);
      expect(new Set(paged).size).toBe(paged.length);
    });
  });

  describe('updated_since (incremental sync)', () => {
    it('filters out products older than the watermark', async () => {
      const { body } = await get('/products?updated_since=2026-08-20T00:00:00Z');
      const ids = body.products.map((p: { id: string }) => p.id);
      expect(ids).toContain('P-1001');
      expect(ids).toContain('P-1006');
      // P-1007 (2026-06-15) and P-1004 (2026-07-02) are older.
      expect(ids).not.toContain('P-1007');
      expect(ids).not.toContain('P-1004');
    });

    it('is inclusive of the watermark itself', async () => {
      const { body } = await get('/products?updated_since=2026-08-20T09:15:00Z');
      expect(body.products.map((p: { id: string }) => p.id)).toContain('P-1001');
    });

    it('combines with pagination', async () => {
      const { body } = await get('/products?updated_since=2026-08-20T00:00:00Z&page=1&limit=2');
      expect(body.products).toHaveLength(2);
      expect(body.total).toBeLessThan(8);
    });

    it('rejects a malformed timestamp with 400', async () => {
      const { statusCode, body } = await get('/products?updated_since=not-a-date');
      expect(statusCode).toBe(400);
      expect(body.error).toBe('invalid_updated_since');
    });

    it('moves updated_at when the ERP changes stock, so incremental sync sees it', async () => {
      const before = (await get('/products')).body.products.find(
        (p: { id: string }) => p.id === 'P-1007',
      );
      sandbox.products.setStock('P-1007', 3);
      const after = (await get('/products')).body.products.find(
        (p: { id: string }) => p.id === 'P-1007',
      );
      expect(after.stock).toBe(3);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
        new Date(before.updated_at).getTime(),
      );

      const recent = await get(`/products?updated_since=${before.updated_at}`);
      expect(recent.body.products.map((p: { id: string }) => p.id)).toContain('P-1007');
    });
  });
});
