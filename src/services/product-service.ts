/**
 * Catalog service.
 *
 * ONE serializer feeds both catalog transports (contract 6.5):
 *   - pull:  GET /products                     (WeAreDA -> Reseller)
 *   - push:  product.updated webhook events    (Reseller -> WeAreDA)
 *
 * Stock lives here too, and it is only ever changed by an EXPLICIT ERP
 * simulation (`npm run cli -- stock ...`). Nothing in the order flow touches it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from '../storage/db.js';
import type { Product, ProductImage, ProductVariant } from '../weareda/types.js';
import { isoNow } from '../lib/ids.js';

export interface ProductListQuery {
  page?: number;
  limit?: number;
  updatedSince?: string;
}

export interface ProductListResult {
  products: Product[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 500;

export class ProductService {
  private readonly catalog: Product[];

  constructor(
    private readonly db: Database,
    catalogPath = 'data/products.json',
    /**
     * Base URL product images are resolved against. WeAreDA fetches image URLs
     * itself, so they must be absolute and reachable - see resolveImage().
     */
    private readonly baseUrl = '',
  ) {
    const raw = readFileSync(resolve(process.cwd(), catalogPath), 'utf8');
    this.catalog = JSON.parse(raw) as Product[];
    this.seedStock();
  }

  /**
   * Seeds SQLite stock levels from the JSON catalog the first time a product or
   * variant is seen. Existing rows are left alone so that ERP-simulated stock
   * survives a restart of the sandbox.
   *
   * The seed timestamp is the product's OWN updated_at, not "now": seeding is
   * not a change, and stamping it with the current time would make every
   * product look freshly modified to an incremental `updated_since` pull.
   */
  private seedStock(): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO stock_levels (entity_type, entity_id, quantity, updated_at) VALUES (?, ?, ?, ?)',
    );
    for (const product of this.catalog) {
      const seededAt = product.updated_at ?? isoNow();
      insert.run('product', product.id, product.stock ?? 0, seededAt);
      for (const variant of product.variants ?? []) {
        insert.run('variant', variant.id, variant.stock ?? 0, seededAt);
      }
    }
  }

  private stockOf(entityType: 'product' | 'variant', id: string, fallback: number): number {
    const row = this.db
      .prepare('SELECT quantity FROM stock_levels WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, id) as { quantity: number } | undefined;
    return row ? row.quantity : fallback;
  }

  private stockUpdatedAt(entityType: 'product' | 'variant', id: string): string | undefined {
    const row = this.db
      .prepare('SELECT updated_at FROM stock_levels WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, id) as { updated_at: string } | undefined;
    return row?.updated_at;
  }

  /**
   * Serializes one product exactly as the contract describes it (4.2). The same
   * output goes into `GET /products` and into a `product.updated` batch.
   */
  serialize(product: Product): Product {
    const variants: ProductVariant[] = (product.variants ?? []).map((variant) => ({
      ...variant,
      stock: this.stockOf('variant', variant.id, variant.stock ?? 0),
    }));

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      price: product.price,
      compare_at_price: product.compare_at_price ?? null,
      currency: product.currency,
      status: product.status ?? 'active',
      stock: this.stockOf('product', product.id, product.stock ?? 0),
      images: (product.images ?? []).map((image) => this.resolveImage(image)),
      updated_at: this.effectiveUpdatedAt(product),
      variants,
    };
  }

  /**
   * Turns a catalog image reference into an absolute URL.
   *
   * The fixtures ship as repo-relative paths (`/fixtures/products/x.png`)
   * because a URL is only useful once you know the host - and locally that host
   * is whatever your tunnel happens to be today. Serializing resolves them
   * against PUBLIC_BASE_URL, so with a tunnel running WeAreDA receives
   * https://<tunnel-host>/fixtures/products/x.png and can actually fetch it.
   *
   * Absolute URLs in the catalog are passed through untouched, which is what a
   * real ERP pointing at its own CDN would have.
   *
   * Both accepted shapes are preserved (contract 4.2): a plain string, or an
   * object keyed by src / url / image.
   */
  private resolveImage(image: ProductImage): ProductImage {
    if (typeof image === 'string') return this.absoluteUrl(image);

    const resolved: { src?: string; url?: string; image?: string } = { ...image };
    for (const key of ['src', 'url', 'image'] as const) {
      const value = resolved[key];
      if (typeof value === 'string') resolved[key] = this.absoluteUrl(value);
    }
    return resolved;
  }

  private absoluteUrl(value: string): string {
    if (!value.startsWith('/')) return value;
    return this.baseUrl ? `${this.baseUrl}${value}` : value;
  }

  /**
   * `updated_at` must move when stock moves, otherwise an incremental pull
   * (`updated_since`) would never see an ERP stock change.
   */
  private effectiveUpdatedAt(product: Product): string | undefined {
    const candidates = [product.updated_at, this.stockUpdatedAt('product', product.id)];
    for (const variant of product.variants ?? []) {
      candidates.push(this.stockUpdatedAt('variant', variant.id));
    }
    const timestamps = candidates.filter((value): value is string => Boolean(value));
    if (timestamps.length === 0) return product.updated_at;
    return timestamps.reduce((latest, value) => (value > latest ? value : latest));
  }

  all(): Product[] {
    return this.catalog.map((product) => this.serialize(product));
  }

  find(id: string): Product | undefined {
    const product = this.catalog.find((candidate) => candidate.id === id);
    return product ? this.serialize(product) : undefined;
  }

  /**
   * Page-number pagination exactly as WeAreDA drives it (contract 4.2): it
   * requests page=1,2,... until a page returns FEWER items than `limit`.
   *
   * `updated_since` is applied inclusively (`updated_at >= updated_since`).
   * Inclusive is the safe choice for a watermark: re-sending a boundary product
   * is a harmless no-op on WeAreDA's side, whereas an exclusive comparison can
   * drop a product that shares the watermark's exact timestamp.
   */
  list(query: ProductListQuery = {}): ProductListResult {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE));

    let items = this.all();
    if (query.updatedSince) {
      const since = new Date(query.updatedSince).getTime();
      items = items.filter((product) => {
        if (!product.updated_at) return false;
        return new Date(product.updated_at).getTime() >= since;
      });
    }

    const offset = (page - 1) * limit;
    const pageItems = items.slice(offset, offset + limit);

    return {
      products: pageItems,
      page,
      limit,
      total: items.length,
      has_more: offset + pageItems.length < items.length,
    };
  }

  /**
   * Applies an ERP stock change.
   *
   * IMPORTANT:
   * This is only ever called from the explicit ERP simulation CLI, never from an
   * order route. Receiving or cancelling an order does not call this method -
   * see contract 6.4.
   *
   * `quantity` is the new ABSOLUTE on-hand value, never a delta.
   */
  setStock(
    entityId: string,
    quantity: number,
  ): { entityType: 'product' | 'variant'; previous: number; quantity: number } {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new Error(`quantity must be a non-negative integer (received ${quantity})`);
    }

    const entityType = this.resolveEntityType(entityId);
    if (!entityType) {
      throw new Error(`unknown product or variant id: ${entityId}`);
    }

    const previous = this.stockOf(entityType, entityId, 0);
    this.db
      .prepare(
        `INSERT INTO stock_levels (entity_type, entity_id, quantity, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
      )
      .run(entityType, entityId, quantity, isoNow());

    return { entityType, previous, quantity };
  }

  resolveEntityType(entityId: string): 'product' | 'variant' | null {
    if (this.catalog.some((product) => product.id === entityId)) return 'product';
    for (const product of this.catalog) {
      if ((product.variants ?? []).some((variant) => variant.id === entityId)) return 'variant';
    }
    return null;
  }

  /** Total on-hand quantity, used by tests that assert stock did not move. */
  stockSnapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const product of this.catalog) {
      snapshot[product.id] = this.stockOf('product', product.id, product.stock ?? 0);
      for (const variant of product.variants ?? []) {
        snapshot[variant.id] = this.stockOf('variant', variant.id, variant.stock ?? 0);
      }
    }
    return snapshot;
  }
}
