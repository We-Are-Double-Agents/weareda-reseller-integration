# Stock

Contract §6.2 and §6.4.

This is the most important page in this documentation, because it is the rule
integrators most often get wrong.

---

## Orders and stock are two independent flows

**WeAreDA never infers stock from orders.** No order event — created, confirmed,
sent, `accepted`, `cancelled`, `refunded`, `fulfilled`, `shipped`, `delivered` —
reserves, decrements, increments or restores a single unit of reseller-owned
stock.

**Your system is the authoritative source of truth for stock.**

```
Flow A - order delivery                    Flow B - inventory change
-----------------------                    -------------------------
Order reaches trigger status               Stock changes in your ERP
   |                                          (that order, a supplier
   v  pending                                  delivery, a manual count,
   v  sending                                  a sale in your own shop…)
   |                                          |
   +-- POST /orders --> your ERP              v  you recalculate - your rules
   |                                          |
   <-- 201 { "id": "SO-88771" }               +-- POST stock.updated --> WeAreDA
   |                                          |     absolute quantities
   v  accepted                                v
   :                                          stock_quantity := the values you sent
   <-- order.status: shipped                     + one audit movement per changed line
   |
   v  completed

   changes integration_status                 changes stock
   and NOTHING else                           and NOTHING else
```

| WeAreDA sees | Order `integration_status` | Reseller-owned stock |
|---|---|---|
| `POST /orders` returns `201` | -> `accepted` | **unchanged** |
| `order.status: fulfilled` | -> `completed` | **unchanged** |
| `order.status: cancelled` | -> `cancelled` | **unchanged** |
| `POST /orders/{id}/cancel` returns `2xx` | -> `cancelled` | **unchanged** |
| `stock.updated` | **unchanged** | -> set to the absolute quantities |

An order will very often *cause* stock to change on your side. That
recalculation is your internal responsibility, and it reaches WeAreDA only when
you publish the result. Stock also changes for reasons that have nothing to do
with WeAreDA, and those use **exactly the same mechanism**.

### The typical sequence

1. Receive `POST /orders`.
2. Create/update the order in your ERP.
3. Return `200/201` with your order id → the order is **`accepted`**.
4. Recalculate inventory internally.
5. POST **one** `stock.updated` with **all** affected products and variants →
   stock is **synchronized**.
6. Later, POST separate `order.status` events as fulfilment progresses.

Steps 3 and 5 are different HTTP requests with different event ids, and neither
implies the other. An order can be `accepted` with no stock event ever arriving,
and a `stock.updated` can arrive with no order involved at all.

---

## `stock.updated`

```json
{
  "type": "stock.updated",
  "id": "evt_a13…",
  "items": [
    { "external_product_id": "P-1001", "quantity": 37 },
    { "external_variant_id": "V-2001", "quantity": 5 }
  ]
}
```

### `quantity` is ABSOLUTE

```
"quantity": 37    means    stock is now 37
"quantity": 37    does NOT mean    add 37
"quantity": 0     means    sold out - a real value, applied, not ignored
```

It must be a non-negative integer. Because quantities are absolute, replaying
the same event converges on the same state instead of accumulating — which is
what makes at-least-once delivery safe.

This sandbox refuses to build an event with a negative or fractional quantity,
so a delta-shaped mistake fails locally rather than corrupting your catalog.

### One event carries many lines

`items` can mix any number of products **and** variants in one request.

> There is no requirement to send one webhook per product. Batching every
> affected item into a single `stock.updated` is the intended usage and the
> cheapest for both sides.

```bash
npm run cli -- stock P-1001 37 V-2001 5 V-2002 18
```

sends **one** event with three lines.

### Line resolution

Most specific first:

1. `external_variant_id` → the mapped variant
2. `external_product_id` → the mapped product
3. `sku` → last resort, matched only against products/variants already mapped to
   your connection, and only when it matches **exactly one**. An ambiguous sku is
   skipped rather than guessed.

A line needs one of those three plus a valid `quantity`.

### Partial application is by design

A line that resolves to nothing, or carries an invalid quantity, is **skipped
and counted**. Every other line still applies, and the event is not failed or
retried because of it. Only an event with **no usable line at all** is parked
for a human.

So a typo in one sku does not block the other 40 lines in the batch.

### Audit trail

WeAreDA records a stock movement per changed line: it derives the delta against
the previous on-hand and writes it as `adjustment_in` or `adjustment_out`, with
`stock_after` set to the absolute quantity you sent. A line that does not change
the quantity writes no movement row.

### Scope

Only reseller-owned products are touched, resolved through the mapping built by
the catalog sync. A `stock.updated` can never reach a product that isn't yours.
Nothing about any order is read or written on this path, whatever caused the
inventory change.

---

## How this sandbox demonstrates it

Stock lives in `ProductService`. The order routes and `OrderService` have no
access to it — that is enforced structurally, and asserted by a test that scans
those files for any reference to the stock API.

The only way stock changes here is an explicit ERP simulation:

```bash
npm run cli -- stock P-1001 37
```

which prints two clearly separated steps:

```
STEP 1 - simulate the reseller ERP recalculating inventory
(this is your system's own business; WeAreDA never does this for you)

  product P-1001        42 ->    37  (absolute on-hand)

STEP 2 - report the new absolute quantities to WeAreDA
(ONE stock.updated event carrying all 1 affected line(s))
```

The change persists in SQLite, so a subsequent `GET /products` reports 37 — the
pull and the push agree, as they must.

```bash
npm run scenario:order          # order arrives, stock does NOT move, then ERP moves it
npm run scenario:cancellation   # cancellation, no restock, then explicit restock
```

Both scenarios assert the invariant as they go and say so in their output.

---

## Stock through the catalog

Stock also arrives through the periodic `GET /products` pull, and through the
`stock` field of a `product.updated` push. Both carry the same absolute
semantics.

`stock.updated` is the push version for when you want WeAreDA to know sooner
than the next sync. Prefer it for pure inventory changes: it is smaller, and it
writes the movement audit trail. A product push is for catalog changes.
