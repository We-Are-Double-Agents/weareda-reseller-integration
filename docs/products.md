# Products and the catalog

Contract §4.2 (pull) and §6.5 (push).

Your catalog can travel in **either direction**, and both use the same product
objects. This sandbox implements both, from one serializer
(`ProductService.serialize()`), because the contract says they are the same
objects — so the implementation makes it structurally true.

|  | `mode: "pull"` (default) | `mode: "push"` |
|---|---|---|
| `GET /products` | required, called on a schedule | never called — you need not implement it |
| `product.updated` | accepted (an accelerator) | accepted (the only catalog source) |
| Archive-missing sweep | yes, on full/reconciliation pulls | never — use `status: "archived"` |
| Sync cursor | advances on a successful pull | unused |

Set the mode with `syncConfig.products.mode` at connect time.

---

## Pull: `GET /products`

```http
GET /products?page=1&limit=200
GET /products?page=1&limit=200&updated_since=2026-07-01T00:00:00Z
X-API-Key: <RESELLER_API_KEY>
```

### Pagination

WeAreDA requests `page=1,2,3…` and **stops when a page returns fewer items than
`limit`**. That is the entire protocol — there is no total count to report and
no cursor.

Consequences worth internalising:

- A full page followed by an empty page is normal and correct.
- Never return a short page in the middle of the catalog; WeAreDA would stop
  there and treat the rest as absent — which, on a full pull, means archived.
- Default `pageSize` is 200 (configurable via `sync_config`, 1–500).

This sandbox also returns `page`, `limit`, `total` and `has_more`. WeAreDA
ignores them; they are there to make manual inspection pleasant.

### Response shape

An array, or an object wrapping it under `data` / `products` / `items` /
`results`. This sandbox uses `products`.

```json
{
  "products": [
    {
      "id": "P-1001",
      "sku": "WIDGET-BLK",
      "name": "Black Widget",
      "description": "…",
      "price": 4999,
      "compare_at_price": 5999,
      "currency": "USD",
      "status": "active",
      "stock": 42,
      "images": ["https://cdn.example.com/products/widget-black-1.jpg"],
      "updated_at": "2026-08-20T09:15:00Z",
      "variants": [
        { "id": "V-2001", "sku": "WIDGET-PRO-S", "name": "Small / Black",
          "attributes": { "size": "S" }, "price": 8999, "stock": 12 }
      ]
    }
  ]
}
```

`id` is required — it becomes your `external_product_id`, and it is what later
`stock.updated` events and delivered order items refer to.

### Field resolution

WeAreDA takes the first non-null of several accepted keys, so an ERP that calls
things by other names often needs no mapping at all:

| WeAreDA field | Accepted source keys |
|---|---|
| external_product_id | `id`, `product_id` |
| name | `name`, `title` |
| description | `description`, `body_html` |
| compareAtPrice | `compare_at_price`, `compareAtPrice` |
| stock | `stock`, `stock_quantity`, `inventory_quantity` |
| images | `images` (string[] or `{src\|url\|image}[]`) |
| externalUpdatedAt | `updated_at`, `updatedAt`, `modified_at` |

Anything still mismatched can be remapped with
`sync_config.products.fieldMap`.

`data/products.json` deliberately includes both image forms — plain strings and
`{src}` / `{url}` objects — so you can see that both are accepted.

### `updated_since`

The incremental filter. This sandbox applies it **inclusively**
(`updated_at >= updated_since`).

Inclusive is the safer choice for a watermark: re-sending a product that sits
exactly on the boundary is a harmless no-op on WeAreDA's side, whereas an
exclusive comparison silently drops any product sharing the watermark's exact
timestamp. If your system guarantees strictly increasing timestamps, exclusive
is fine too — the contract does not mandate either.

**`updated_at` must move when stock moves.** Otherwise an incremental pull will
never see an inventory change. This sandbox does that: an ERP stock change bumps
the product's effective `updated_at`, including when the change was to one of
its variants.

### What only a pull can do

Because only a pull sees a *complete* catalog:

- **Archive-missing.** After a `full` or `reconciliation` pull, any
  reseller-owned product you did not return is archived — hidden from the bot,
  still visible in the CRM. An `incremental` pull never archives.
- **Advance the sync cursor.**

A push does neither.

---

## Push: `product.updated`

```bash
npm run cli -- product-update --all
npm run cli -- product-update P-1001 P-1002
npm run cli -- product-update P-1004 --status archived
npm run scenario:catalog-push
```

```json
{
  "type": "product.updated",
  "id": "evt_prod_5…",
  "products": [ { "id": "P-1001", "name": "Black Widget", "stock": 42, "...": "..." } ]
}
```

### The rules

- **`products` is a batch.** Up to **500 per request**, within a **512 KB**
  body. A larger batch is refused with `400 too_many_items` rather than
  truncated — page it as you would page `GET /products`. The CLI pages
  automatically and sends one event per page, each with its own event id.
- **Upsert by `id`.** Unknown → created, known → updated. Variants are matched
  by their own `id` within the product.
- **Same engine as the pull.** A product whose content is unchanged is a no-op;
  a product whose `updated_at` is *older* than what WeAreDA holds is ignored as
  stale, so a redelivered or out-of-order push cannot corrupt the catalog.
- **Reseller-owned fields only.** Name, description, sku, price, compare-at,
  cost, currency, stock, status, images. The tenant's overlay — AI description,
  bot visibility, internal category/tags — is never touched.
- **Malformed items are skipped, not fatal.** An item with no `id` or `name` is
  counted and dropped; the rest of the batch still applies.

### Partial by nature

> A push says **"here is what changed"**, never **"here is everything I have"**.

WeAreDA therefore **never archives** a product just because it was absent from a
batch, and never advances the pull cursor. To retire a product, send it
explicitly:

```json
{ "type": "product.updated", "id": "evt_prod_6…",
  "products": [ { "id": "P-1001", "name": "Black Widget", "status": "archived" } ] }
```

Archived products disappear from the AI agent's answers while staying visible
and auditable in the CRM.

### Stock in a product payload

It is applied like any other reseller-managed field. But for a pure inventory
change prefer `stock.updated`: it is smaller and it writes the stock-movement
audit trail. A product push is for catalog changes. See [stock.md](stock.md).
