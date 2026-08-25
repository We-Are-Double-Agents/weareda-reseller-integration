# Orders

Contract §4.3 (delivery) and §4.4 (cancellation).

> Nothing on this page changes stock. Not delivery, not acceptance, not
> completion, not cancellation. See [stock.md](stock.md).

---

## The integration lifecycle

```
pending  ->  sending  ->  accepted  ->  completed
```

| Step | `integration_status` | What just happened |
|---|---|---|
| 1 | `pending` | The order reached the trigger status and is queued. Nothing sent yet. |
| 2 | `sending` | A `POST /orders` attempt is in flight (also the state between retries). |
| 3 | `accepted` | You answered `2xx`. If your body carried an order id, it is stored as `external_order_id`. **This ends the outbound flow.** |
| 4 | `completed` | Only later, when you send an `order.status` event whose `state` is `fulfilled` / `completed` / `shipped` / `delivered`. |

Off the happy path: `failed` (retries exhausted), `rejected` / `manual_review`
(needs a human). Cancellation runs its own arc: `cancel_pending -> cancelled`
(or `cancel_failed`).

Nothing moves the order from `accepted` to `completed` except an `order.status`
event from you.

---

## `POST /orders`

```http
POST /orders
X-API-Key: <RESELLER_API_KEY>
Content-Type: application/json
Idempotency-Key: order:6b1e…
```

```json
{
  "order_number": "ORD-1042",
  "currency": "USD",
  "subtotal": 10000, "discount": 0, "tax": 0, "shipping": 500, "total": 10500,
  "notes": "leave at door",
  "shipping_address": { "name": "Ada", "line1": "…", "city": "…", "country": "AR" },
  "idempotency_key": "order:6b1e…",
  "items": [
    {
      "sku": "WIDGET-BLK-S",
      "external_product_id": "P-1001",
      "external_variant_id": "V-1",
      "name": "Black Widget", "variant_name": "Small",
      "quantity": 2, "unit_price": 5000, "discount": 0, "subtotal": 10000
    }
  ]
}
```

Two things surprise people about this payload:

1. **There is no `external_order_id`.** WeAreDA identifies the order by
   `order_number` and `idempotency_key`, and adopts *your* id from the response.
2. **There is no customer object.** The shipping address carries the
   recipient's name and whatever contact fields the tenant captured. Nothing
   beyond what you need to fulfil the order is sent — no internal notes, no
   payment tokens.

The item ids (`external_product_id`, `external_variant_id`) are the ids **you**
gave WeAreDA in `/products`.

### What to return

| Status | Meaning | WeAreDA does |
|---|---|---|
| `200/201` + body with an order id | accepted | stores your id as `external_order_id`, marks `accepted` |
| `200/201` with no recognizable id | accepted | marks `accepted`, but `external_order_id` stays empty |
| `409` | you already have this idempotency key | treated as accepted; **no id is stored from a 409** |
| `401/403` | auth failed | non-retryable -> `manual_review` |
| `5xx` / timeout | transient | retried with backoff |
| other `4xx` | rejected | non-retryable -> `manual_review` |

```json
{ "id": "SO-10001", "status": "received" }
```

The id may be in `id`, `order_id` or `external_order_id` (or a field you name
via `sync_config.orders.orderIdField`). This sandbox returns `id`.

> **Always return your order id on the first `2xx`.** Without it, WeAreDA can
> only match your later `order.status` events by `order_number`, and the
> per-order cancel path degrades to the fallback endpoint.

### Idempotency

The same key arrives as a header **and** in the body. It is stable per entity:
`order:<orderId>` for delivery, `order-cancel:<orderId>` for cancellation.

If you have seen the key before, do **not** create a second order. Return either
`409`, or `200` with the existing order.

**This sandbox returns `200` with the existing order**, because a `409` carries
no id — so WeAreDA stores no `external_order_id` from it. Returning the order is
both easier to follow in a demo and strictly more useful.

```
[ORDER]
Duplicate delivery detected.
Idempotency-Key: order:6b1e
Existing order: SO-10001
No duplicate order created.
```

This guards the "processed but the response timed out" case, where WeAreDA
retries an operation you already completed.

### Validation

This reference rejects, with `400`:

- no `items`, or an empty array
- an item with no `external_product_id`, `external_variant_id` or `sku`
- an item with a non-positive `quantity`
- an order with neither `order_number` nor `idempotency_key`

Everything else is accepted and stored verbatim. Be conservative here: a
non-auth `4xx` is **not retried**, so a strict validator turns a recoverable
hiccup into a manual-review ticket.

---

## Cancellation

When a **delivered** order is later cancelled or refunded in WeAreDA, you are
notified. An order that never reached `accepted` or `completed` is simply never
delivered, so you never hear about it.

```http
POST /orders/SO-10001/cancel
Idempotency-Key: order-cancel:6b1e…
```

```json
{
  "order_number": "ORD-1042",
  "external_order_id": "SO-10001",
  "reason": "cancelled",
  "idempotency_key": "order-cancel:6b1e…"
}
```

If WeAreDA holds no `external_order_id` for the order, it uses the fallback
instead, matching by `order_number` or `idempotency_key`:

```http
POST /orders/cancel
```

### What to return

| Status | WeAreDA does |
|---|---|
| `2xx` | order marked `cancelled` |
| `404` (you don't have it) | treated as **idempotent success** |
| `409` (already cancelled) | treated as **idempotent success** |
| `5xx` / timeout | retried |
| other `4xx` | `manual_review` |

This sandbox answers `200` for an already-cancelled order (with
`already_cancelled: true`) and `404` only when nothing matches at all.

### Lookup in this sandbox

Most specific first:

1. the reseller order id — the path parameter, or `external_order_id` in the body
2. `order_number`
3. `idempotency_key`

For (3) there is a small trick worth stealing: WeAreDA derives both keys from
the same order, so `order-cancel:6b1e` and `order:6b1e` share a suffix. The
lookup strips the known prefix and matches on the suffix, which lets a
fallback cancellation find an order delivered under the sibling key.

### Cancellation does not restock

> If cancelling returns units to your inventory, that is your ERP's decision,
> and it reaches WeAreDA as a separate `stock.updated` with the new absolute
> quantities. WeAreDA will not add the units back on its own.

```bash
npm run scenario:cancellation
```

walks through exactly that, step by step.

---

## Reporting progress back

As fulfilment moves, send one `order.status` event **per transition**, each with
its own event id:

```bash
npm run cli -- order-status SO-10001 accepted
npm run cli -- order-status SO-10001 shipped
npm run cli -- order-status SO-10001 delivered
```

| Your `state` (aliases) | `integration_status` |
|---|---|
| `accepted` / `acknowledged` / `ack` | `accepted` |
| `fulfilled` / `completed` / `shipped` / `delivered` | `completed` |
| `cancelled` / `canceled` | `cancelled` |
| `rejected` / `failed` / `error` | `manual_review` |
| anything else | **not mapped** |

An unmapped state is not an error and not a `manual_review`: the event is parked
for a human, and the order's `integration_status` is left **exactly as it was**.
The same applies when the order reference matches nothing. Try it:

```bash
npm run cli -- order-status SO-10001 packed_in_warehouse
```

Reaching `completed` does not block later events — a subsequent `cancelled`
still applies. Re-sending the same state is harmless.

By default this updates only the *integration* status, not the customer-facing
order status.
