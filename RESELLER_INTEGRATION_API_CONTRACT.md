# Reseller Integration — Data API Contract

**Audience:** engineers on the **reseller side** (your commerce / ERP / order
system) integrating with WeAreDA.

This document specifies the **runtime data contract** between WeAreDA and your
system — what WeAreDA **sends you** (outbound), what you **send WeAreDA**
(inbound webhooks), the exact endpoints, headers, and example payloads. For
one-time *provisioning* (creating customers/tenants, login links, branding) see
`RESELLER_INTEGRATION_GUIDE.md` — that is a separate API.

> **Principle:** HTTP endpoints and webhooks externally; queues, retries,
> idempotency, and auditing internally. Every write is **at-least-once** and
> **idempotent** — you will occasionally receive the same operation twice and must
> treat it as a no-op the second time.

> **Read this before anything else — orders and stock are two independent flows.**
> WeAreDA **never** infers, reserves, decrements, or restores your stock because an
> order was created, confirmed, sent, accepted, cancelled, fulfilled, or delivered.
> **You** are the authority on your stock. When an order changes your inventory, that
> is your system's internal business; you tell us the result with a **separate**
> `stock.updated` webhook carrying **absolute** quantities. See §6.4.

---

## 1. The two directions

```
                 OUTBOUND  (WeAreDA  ──HTTP──▶  your system, at your base_url)
                 ─────────────────────────────────────────────────────────────
                 GET   /                     health / test connection
                 GET   /products             product + stock catalog (pull sync)
                 POST  /orders               deliver a confirmed order
                 POST  /orders/{id}/cancel   cancel/refund a delivered order

                 INBOUND   (your system  ──HTTP──▶  WeAreDA webhook)
                 ─────────────────────────────────────────────────────────────
                 POST  {WEAREDA_API}/api/v1/reseller-webhooks/{connectionId}
                       type: order.status | stock.updated
                           | product.updated | invoice.issued
```

> **Your catalog can travel either way.** By default WeAreDA **pulls** it from
> `GET /products` on a schedule. If you would rather **push** it — because your ERP
> already emits change events, or because you do not want to host a read endpoint —
> set `sync_config.products.mode = "push"` (§7) and POST `product.updated` events
> instead (§6.5). In push mode WeAreDA never calls your `GET /products`.

- **Outbound** endpoints live on **your** server (the `base_url` you register).
  WeAreDA is the client; **you implement these**.
- **Inbound** is a single WeAreDA webhook that **you call** when something changes
  on your side. **One event per HTTP request** (§6) — `order.status` and
  `stock.updated` are always two separate calls, never one combined payload.

### 1.1 `integrationMode` — the four shapes an integration can take

Four calls go from WeAreDA to your server, and they split along **two independent
questions**: do we ever *call you to read*, and do you ever *receive an order*?

| Call | Axis |
|---|---|
| `GET /` (connection test) | **reads** |
| `GET /products` (catalog pull) | **reads** |
| `POST /orders` | **order delivery** |
| `POST /orders/{id}/cancel` | **order delivery** |

Two axes, four modes. Pick the row that describes your system:

| `integrationMode` | We read from you | You receive orders | Your catalog reaches us by | You must implement |
|---|---|---|---|---|
| **`query_and_send`** *(default)* | ✓ `GET /` + `GET /products` | ✓ | scheduled pull (+ pushes accepted) | all four calls |
| **`receive_and_send`** | ✗ never | ✓ | `product.updated` only | `POST /orders` + cancel |
| **`query_only`** | ✓ `GET /` + `GET /products` | ✗ never | scheduled pull (+ pushes accepted) | `GET /` + `GET /products` |
| **`receive_only`** | ✗ never | ✗ never | `product.updated` only | **nothing** — you only publish webhooks |

**Inbound webhooks are not an axis.** You may publish `product.updated`,
`stock.updated`, `order.status` and `invoice.issued` in *every* mode, as long as a
webhook secret is configured. What the mode changes is only what **we** do.

Consequences worth stating plainly:

- **`receive_and_send` is not "no outbound calls".** We still deliver orders to you —
  delivering an order is a *send*, not a query. You still register a `baseUrl` and
  still implement `POST /orders` and its cancel.
- **In any mode where we do not read**, no sync schedule is created (and one left by
  a previous connect is removed), `GET /products` is never called, and
  `POST …/integration/test-connection` is refused with `422 read_calls_disabled` —
  the test *is* a read. Your catalog then reaches us **only** through
  `product.updated`; stop publishing and it simply stops updating, with no error.
- **In any mode where you do not receive orders**, `ordersWrite` is switched off in
  the integration's effective capabilities, so orders never enter the delivery queue
  at all. Nothing is queued and later refused — the connection is simply not a
  candidate.
- **`receive_only` still requires a `baseUrl`** at connect time, even though nothing
  is ever sent to it. It is registered, not called.
- **`orderStatusWrite` (§6.1) needs a mode that delivers orders.** Combining it with
  `query_only` or `receive_only` is refused with a `400`: those resellers never
  receive an order from us, so they have none to report a status on and the flag
  could never fire. It is otherwise independent of the mode — see below.

The mode also decides the catalog transport, so `sync_config.products.mode` is
derived from it and must not be set to a contradictory value — doing so is a `400`,
not a precedence puzzle. An integration configured before this setting existed with
`products.mode: "push"` reads as **`receive_and_send`** (reads off, orders still
delivered); nothing to change.

The connect response and `GET …/integration/status` both echo the resolved
`integrationMode` and `orderDeliveryEnabled`.

---

Two lifecycles run over those endpoints, and they never touch each other:

| Lifecycle | Moved by | Affects | Never affects |
|---|---|---|---|
| **Order integration** — `pending → sending → accepted → completed` | `POST /orders` (outbound) and `order.status` (inbound) | the order's `integration_status` and `external_order_id` — plus the customer-facing order status when `orderStatusWrite` is on (§6.1) | **stock** |
| **Stock** | `stock.updated` (inbound), and the catalog sync (either direction) | reseller-owned `stock_quantity` + a stock-movement audit row | **order status** |
| **Catalog** | `GET /products` (pull) **or** `product.updated` (push) | reseller-owned product/variant rows | **order status** |

All endpoint paths, query-parameter names, and response field names shown here are
the **defaults**; every one is overridable per integration via `sync_config`
(§7) if your system uses different conventions.

---

## 2. Configuration (one-time, per customer)

You register an integration for each of your customers (tenants) through the
reseller config API (see the provisioning guide for auth):

```
POST /api/v1/resellers/me/tenants/{tenantId}/integration/connect
{
  "provider": "generic_http",
  "baseUrl": "https://api.your-erp.com/v1",     // your outbound base (https, public host)
  "authType": "api_key",                          // api_key | bearer | basic | custom
  "externalCredentials": { "apiKey": "sk_live_…" },
  "webhookSecret": "whsec_…",                     // optional but REQUIRED to send us webhooks
  "orderDeliveryStatus": "confirmed",             // which order status triggers delivery
  "orderStatusWrite": false,                      // opt-in: let order.status move the
                                                  //   customer-facing status too (§6.1)
  "integrationMode": "query_and_send",            // query_and_send (default) |
                                                  //   receive_and_send | query_only |
                                                  //   receive_only — see §1.1
  "syncConfig": { }                               // optional overrides — see §7
}
```

The response includes your **inbound webhook URL**:

```json
{ "status": "connected", "provider": "generic_http",
  "webhookUrl": "https://api.weareda.com/api/v1/reseller-webhooks/<connectionId>",
  "webhookSecretStatus": "configured", "effectiveCapabilities": { … } }
```

**Capabilities** gate which flows are active for you (a reseller cannot self-grant
them — the platform authorizes the ceiling): `productsRead`, `stockRead`,
`ordersWrite`, `invoices`. `productsRead` authorizes your catalog in **both**
directions — the `GET /products` pull and the `product.updated` push are the same
permission over two transports.

The response also echoes `productsSyncMode` (`pull` | `push`) and the validated
`syncConfig` we stored, so you can confirm what took effect.

---

## 3. Authentication

### 3.1 Outbound — how WeAreDA authenticates **to you**

WeAreDA attaches the credentials you registered, by `authType`:

| authType | Header WeAreDA sends |
|---|---|
| `api_key` (default) | `X-API-Key: <apiKey>` |
| `bearer` | `Authorization: Bearer <accessToken \| apiKey>` |
| `basic` | `Authorization: Basic base64(clientId:clientSecret)` |
| `custom` | an arbitrary map of headers you supplied (e.g. `X-Auth-Token: …`) |

Every outbound request also carries `Accept: application/json`; writes add
`Content-Type: application/json` and an idempotency header (§5).

### 3.2 Inbound — how you authenticate **to WeAreDA**

You sign the webhook with the **`webhookSecret`** you registered. Compute an
HMAC-SHA256 over the **exact raw request body bytes** and send it hex-encoded:

```
X-WeAreDA-Signature: sha256=<hex HMAC_SHA256(rawBody, webhookSecret)>
X-WeAreDA-Event-Id: <your unique event id>          # used for dedup; recommended
X-WeAreDA-Timestamp: <unix seconds or ms>           # optional; ±5 min replay window
Content-Type: application/json
```

- The signature is verified **constant-time** over the untouched bytes — sign the
  serialized body you actually send (don't re-serialize).
- A connection with **no** configured webhook secret is rejected (`401`); we never
  accept an unauthenticated webhook.
- `X-WeAreDA-Event-Id` is your idempotency key for the event — resending the same
  id is deduped (`200 {deduped:true}`). If you omit it, we derive one from the body
  hash (so identical bodies still dedup).

**Signature example (Node.js):**
```js
import crypto from "node:crypto";
const body = JSON.stringify(event);                       // the exact string you POST
const sig  = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
await fetch(webhookUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-WeAreDA-Signature": `sha256=${sig}`,
    "X-WeAreDA-Event-Id": event.id,
  },
  body,                                                    // must be the SAME string
});
```

---

## 4. OUTBOUND — endpoints you implement (WeAreDA → you)

Base = the `baseUrl` you registered. All examples assume
`baseUrl = https://api.your-erp.com/v1`.

### 4.1 Test connection — `GET /`

WeAreDA calls your **base URL** with the auth header to verify credentials.
Return any `2xx`. `401/403` ⇒ credentials rejected; `5xx`/timeout ⇒ retryable.

```
GET https://api.your-erp.com/v1
X-API-Key: sk_live_…
→ 200 OK   (body ignored)
```

### 4.2 Product & stock pull — `GET /products`  *(capability: productsRead / stockRead)*

> **Optional.** This endpoint is only required in the default `pull` mode. If you set
> `sync_config.products.mode = "push"` (§7) you do not need to implement it at all —
> your catalog arrives through `product.updated` (§6.5) instead, and WeAreDA never
> calls you here.

WeAreDA periodically pulls your catalog (page-number pagination). Incremental
syncs add an `updated_since` filter.

```
GET https://api.your-erp.com/v1/products?page=1&limit=200
GET https://api.your-erp.com/v1/products?page=1&limit=200&updated_since=2026-07-01T00:00:00Z
X-API-Key: sk_live_…
```

**Response** — an array, or an object wrapping it under `data` / `products` /
`items` / `results`:

```json
{
  "products": [
    {
      "id": "P-1001",                       // external_product_id (required)
      "sku": "WIDGET-BLK",
      "name": "Black Widget",
      "description": "…",
      "price": 4999,                        // your unit; WeAreDA stores as-is
      "compare_at_price": 5999,
      "currency": "USD",
      "status": "active",
      "stock": 42,                          // or stock_quantity / inventory_quantity
      "images": ["https://…/a.jpg"],        // strings or {src|url|image}
      "updated_at": "2026-07-10T12:00:00Z",
      "variants": [
        { "id": "V-1", "sku": "WIDGET-BLK-S", "name": "Small",
          "attributes": {"size":"S"}, "price": 4999, "stock": 10 }
      ]
    }
  ]
}
```

**Field resolution** (first non-null wins; override via `sync_config.products.fieldMap`):

| WeAreDA field | Accepted source keys |
|---|---|
| external_product_id | `id`, `product_id` |
| sku | `sku` |
| name | `name`, `title` |
| description | `description`, `body_html` |
| price | `price` |
| compareAtPrice | `compare_at_price`, `compareAtPrice` |
| stock | `stock`, `stock_quantity`, `inventory_quantity` |
| images | `images` (string[] or `{src\|url\|image}[]`) |
| externalUpdatedAt | `updated_at`, `updatedAt`, `modified_at` |
| variant id / sku / stock | `id`/`variant_id`, `sku`, `stock`/`stock_quantity`/`inventory_quantity` |

**Pagination:** WeAreDA requests `page=1,2,…` until a page returns fewer than
`limit` items. Ownership: products imported this way are **reseller-owned** in
WeAreDA (the tenant sees an overlay for AI description / visibility only).

**Two things only a pull can do**, because only a pull sees a *complete* catalog:

- **Archive-missing.** After a `full` or `reconciliation` pull, any reseller-owned
  product you did **not** return is archived (hidden from the bot, still visible in
  the CRM). An `incremental` pull never archives.
- **Advance the sync cursor** (`updated_since` watermark) on a fully successful run.

A `product.updated` push does neither — see §6.5.

### 4.3 Order delivery — `POST /orders`  *(capability: ordersWrite)*

When a customer's order reaches the trigger status (`orderDeliveryStatus`, default
`confirmed`), WeAreDA delivers it to you **exactly once** (idempotent).

**Integration lifecycle — `pending → sending → accepted → completed`:**

| Step | `integration_status` | What just happened |
|---|---|---|
| 1 | `pending` | The order reached the trigger status and is **queued** for delivery. Nothing has been sent to you yet. |
| 2 | `sending` | A `POST /orders` attempt is **in flight** (this is also the state between retries). |
| 3 | `accepted` | You answered `2xx`. If your body carried an order id, it is stored as `external_order_id`. **This is the end of the outbound flow** — WeAreDA will not move the order further on its own. |
| 4 | `completed` | **Only** reached later, when you send an inbound `order.status` event whose `state` is `fulfilled` / `completed` / `shipped` / `delivered` (§6.1). |

Off the happy path: `failed` (retries exhausted), `rejected` / `manual_review`
(needs a human). Cancellation runs its own arc, `cancel_pending → cancelled` (or
`cancel_failed`) — see §4.4. The full list is in §8.

> **No step of this lifecycle touches stock.** Delivering, accepting, completing
> or cancelling an order changes the order's `integration_status` (and
> `external_order_id`), and — only under the `orderStatusWrite` opt-in of §6.1 —
> the customer-facing order status. It never moves a single unit of inventory. If
> the order changed yours, send us a separate `stock.updated` (§6.2, §6.4).

**What the payload contains.** The complete order as WeAreDA holds it: order
number, currency, all monetary totals (`subtotal`, `discount`, `tax`, `shipping`,
`total`), notes, the shipping address (which carries the recipient's `name` and
whatever address/contact fields the tenant captured), a **`customer` object**, the
idempotency key, and one line per item with `sku`, `external_product_id`,
`external_variant_id` (the ids you gave us in `/products`), display name, variant
name, `quantity`, `unit_price`, `discount` and line `subtotal`. Nothing beyond what
you need to fulfil **and invoice** the order is sent — no internal notes, no contact
custom fields, and no payment tokens.

**`customer` (added 2026-09; optional, additive).** The customer the order was
created for, including their **fiscal identification** when the tenant captured one:

```json
"customer": {
  "id": "contact-uuid",
  "name": "Juan Pérez",
  "first_name": "Juan",
  "last_name": "Pérez",
  "email": "juan@example.com",
  "phone": "+541112345678",
  "tax_id": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
}
```

- `tax_id` is **`null`** when the contact has no fiscal identification — the key is
  always present inside `customer`, so you can branch on it without guessing.
- `tax_id.type` is a **free short token**, not an enum: `CUIT`, `CUIL`, `DNI`, `CPF`,
  `CNPJ`, `NIF`, `NIE`, `CIF`, `RFC`, `EIN`, `SSN`, `VAT`, `TAX_ID` — or any other
  identifier a country uses. Do not reject an unknown one.
- `tax_id.country` is an **ISO 3166-1 alpha-2** code.
- The whole `customer` key is **omitted** when the order has no contact at all.
- **The values are a snapshot** taken when the order was created — see §4.3.1.
- Fiscal identification is **optional** unless you opt into
  `syncConfig.orders.requiresTaxId` (§7.2).

#### 4.3.1 The customer is a snapshot, not a live read

The customer we send you (and return in §11) is **copied onto the order when the
order is created**, not read from the contact at delivery time. If the tenant later
corrects the contact's tax id, an order you already received — and possibly already
invoiced — keeps the identity it was created with. New orders carry the new value.

This is deliberate: an invoice is issued against a fiscal identity, and that
identity must not change retroactively. Orders created before this shipped have no
snapshot; for those we fall back to the contact as it is today, exactly as before.

One exception, in your favour: if the order was created **before the customer had
any** fiscal identification, and the tenant captures one later, that order starts
reporting it. The snapshot freezes a *value*, not an *absence* — so an order parked
under `requiresTaxId` (§4.3.2) becomes deliverable once the tenant completes the
contact. A fiscal id we already recorded on an order **never** changes.

#### 4.3.2 Requiring a fiscal id (`requiresTaxId`)

If you cannot accept an order without the customer's fiscal identifier, set
`syncConfig.orders.requiresTaxId: true` (§7.2). An order whose customer has no
`tax_id.type` + `tax_id.value` is then **never sent** to you — it simply is not yet
eligible for delivery, and it **is delivered automatically, within a minute, as soon
as the tenant completes the contact**. Nothing is lost and nobody has to re-queue
anything: the order waits rather than arriving for you to reject.

Default is `false`, which is the behaviour every existing integration keeps.

> This never blocks order creation inside the CRM. A tenant can always take an order
> from a customer who has not given a tax id; only the delivery to *you* waits.

**Request:**
```
POST https://api.your-erp.com/v1/orders
X-API-Key: sk_live_…
Content-Type: application/json
Idempotency-Key: order:6b1e…                 # also present in the body
```
```json
{
  "order_number": "ORD-1042",
  "currency": "USD",
  "subtotal": 10000, "discount": 0, "tax": 0, "shipping": 500, "total": 10500,
  "notes": "leave at door",
  "shipping_address": { "name": "Ada", "line1": "…", "city": "…", "country": "AR" },
  "customer": {
    "id": "contact-uuid",
    "name": "Ada Lovelace",
    "first_name": "Ada", "last_name": "Lovelace",
    "email": "ada@example.com",
    "phone": "+541112345678",
    "tax_id": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
  },
  "idempotency_key": "order:6b1e…",
  "items": [
    {
      "sku": "WIDGET-BLK-S",
      "external_product_id": "P-1001",       // the ids you sent us in /products
      "external_variant_id": "V-1",
      "name": "Black Widget", "variant_name": "Small",
      "quantity": 2, "unit_price": 5000, "discount": 0, "subtotal": 10000
    }
  ]
}
```

**Response you must return:**

| Status | Meaning | WeAreDA does |
|---|---|---|
| `200/201` + body with an order id | accepted | stores your id as `external_order_id`, marks `accepted` |
| `200/201` with **no** recognizable id | accepted | marks `accepted`, but `external_order_id` stays empty (see the caveat below) |
| `409` | you already have this idempotency key | treated as **accepted** (idempotent); no id is stored from a `409` |
| `401/403` | auth failed | non-retryable → `manual_review` |
| `5xx` / timeout | transient | **retried** with backoff |
| other `4xx` | rejected | non-retryable → `manual_review` |

Return your id in `id` / `order_id` / `external_order_id` (or a field you set via
`sync_config.orders.orderIdField`):
```json
{ "id": "SO-88771", "status": "received" }
```

> **Always return your order id.** Any `2xx` marks the order `accepted`, but without
> an `external_order_id` we can only match your later `order.status` events by
> `order_number`, and the per-order cancel path (§4.4) degrades to the fallback
> endpoint. Returning the id on the first `2xx` is strongly recommended.

**Idempotency (critical):** the same `idempotency_key` is sent as a header **and**
in the body. If you have already processed it, return `409` (or `200` with the same
order) — do **not** create a duplicate. This guards the "processed but the response
timed out" case, where WeAreDA retries.

### 4.4 Order cancellation — `POST /orders/{externalOrderId}/cancel`  *(capability: ordersWrite)*

When a **delivered** order is later cancelled or refunded in WeAreDA, we notify
you. If we hold your `external_order_id` we call the per-order path; otherwise a
fallback `POST /orders/cancel` (match by `order_number` / `idempotency_key`).

```
POST https://api.your-erp.com/v1/orders/SO-88771/cancel
X-API-Key: sk_live_…
Content-Type: application/json
Idempotency-Key: order-cancel:6b1e…
```
```json
{
  "order_number": "ORD-1042",
  "external_order_id": "SO-88771",
  "reason": "cancelled",                     // "cancelled" | "refunded"
  "idempotency_key": "order-cancel:6b1e…"
}
```

**Response:**

| Status | WeAreDA does |
|---|---|
| `2xx` | order marked `cancelled` |
| `404` (you don't have it) / `409` (already cancelled) | treated as **idempotent success** |
| `5xx` / timeout | retried |
| other `4xx` | `manual_review` |

Only an order that already reached `accepted` or `completed` is cancelled with you
— one that never got that far is simply not delivered.

> **Cancellation does not restock anything on our side.** If cancelling the order
> returns units to your inventory, send a `stock.updated` with the new absolute
> quantities (§6.2). WeAreDA will not add the units back on its own.

---

## 5. Idempotency & retries (both directions)

- **Outbound writes** carry an `Idempotency-Key` (header + body). Keys are stable
  per entity: `order:<orderId>`, `order-cancel:<orderId>`. Dedupe on it.
- WeAreDA **retries** `5xx`/timeout with exponential backoff (up to 5 attempts),
  then routes to a dead-letter queue + alert. `4xx` auth/validation is **not**
  retried (flagged for a human).
- **Inbound events** dedupe on `X-WeAreDA-Event-Id`; a duplicate returns
  `200 {deduped:true}`. Make your event ids **stable per real-world event** (so a
  retry of the same event repeats the id) and **unique across different events**.
  Dedup is scoped to *connection + event type + event id*: re-POSTing the same
  `stock.updated` id is a no-op, while an `order.status` that happens to reuse an id
  you already used for a `stock.updated` is still processed — but do not rely on
  that, just use distinct ids.

---

## 6. INBOUND — the webhook you call (you → WeAreDA)

**Endpoint:** `POST {webhookUrl}` (the `https://…/api/v1/reseller-webhooks/<connectionId>`
from your connect response). Signed per §3.2.

### 6.0 ONE EVENT TYPE PER HTTP REQUEST

Every request carries **exactly one** event: a single top-level `type` and the one
payload container that belongs to it.

| `type` | Its payload container |
|---|---|
| `order.status` | `order` |
| `stock.updated` | `items` |
| `product.updated` | `products` |
| `invoice.issued` | `invoice` |

✅ **Correct — two events, two requests:**

```http
POST /api/v1/reseller-webhooks/<connectionId>
{ "type": "order.status",  "id": "evt_1", "order": { "external_order_id": "SO-88771", "state": "fulfilled" } }
```
```http
POST /api/v1/reseller-webhooks/<connectionId>
{ "type": "stock.updated", "id": "evt_2", "items": [ { "external_product_id": "P-1001", "quantity": 37 } ] }
```

❌ **Rejected — one request carrying two event types** (`400 multiple_event_types`):

```json
{
  "type": "order.status",
  "order": { "external_order_id": "SO-88771", "state": "fulfilled" },
  "items": [ { "external_product_id": "P-1001", "quantity": 37 } ]
}
```

❌ **Rejected — a batch envelope** (`400 multiple_event_types`). There is no batch
format; send N requests:

```json
{ "events": [ { "type": "order.status", … }, { "type": "stock.updated", … } ] }
```

A mixed payload is refused **whole** — WeAreDA never applies one half and silently
drops the other. `type` must be top-level; an `{ "event": { "type": … } }` wrapper is
not the contract and returns `400 unsupported_event`.

*(Batching **within** one event type is not only allowed but expected: a single
`stock.updated` should carry every affected product and variant in `items` (§6.2),
and a single `product.updated` should carry every changed product in `products`
(§6.5). What is forbidden is mixing **types**, not batching **items**.)*

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "accepted": true, "operationId": "…" }` | queued for processing |
| `200` | `{ "deduped": true, "operationId": "…" }` | duplicate event id — no-op |
| `400` | `{ "error": "unsupported_event" }` | unknown or missing top-level `type` |
| `400` | `{ "error": "multiple_event_types" }` | more than one event type, or a batch envelope, in one request |
| `400` | `{ "error": "too_many_items", "max": 500 }` | a `product.updated` batch above the per-event cap (§6.5) |
| `401` | `{ "error": "unauthorized" }` / `{ "error":"stale_timestamp" }` | bad/missing signature, or outside the timestamp window |
| `404` | `{ "error": "not_found" }` | unknown/disconnected connection or disabled integration |

Processing is **asynchronous**: `202` means *accepted*, not *applied*. Effects land
shortly after via WeAreDA's internal queue (under retry/DLQ). Each event is applied
**at most once**: the queued operation is claimed with a state guard, so a redelivery
inside our own infrastructure never doubles an effect or an audit row.

### 6.1 `order.status` — order lifecycle callback

Tell WeAreDA an order changed state on your side. Reference the order by the
`external_order_id` we stored on delivery (preferred), by our own order `id`
(the UUID from `GET .../orders`), or by `order_number`. See §6.3.1 for when to
use which.

```json
{
  "type": "order.status",
  "id": "evt_9f2c…",
  "order": { "external_order_id": "SO-88771", "state": "fulfilled" }
}
```

**`state` → WeAreDA `integration_status`:**

| Your `state` (aliases) | integration_status | order status *(opt-in only)* |
|---|---|---|
| `accepted` / `acknowledged` / `ack` | `accepted` | `confirmed` |
| `shipped` / `fulfilled` | `completed` | `shipped` |
| `delivered` / `completed` | `completed` | `delivered` |
| `cancelled` / `canceled` | `cancelled` | `cancelled` |
| `returned` / `return` / `refunded` / `not_delivered` / `undelivered` | `returned` | `refunded` |
| `rejected` / `failed` / `error` | `manual_review` | *(unchanged)* |
| anything else | **not mapped** — see below | *(unchanged)* |

**Report a return as a return.** `cancelled` means the order never shipped;
`returned` means it shipped and came back. They are different business events and
we keep them apart — a return does **not** trigger a cancellation call back to you.

`rejected` / `failed` / `error` say the *integration* failed, not that the customer's
order reached a business state, so they never move the customer-facing status.

#### The `orderStatusWrite` opt-in

> **This is a separate setting from `integrationMode` (§1.1), on purpose.** The mode
> is a fact about your infrastructure — which HTTP calls happen between us — and is
> stored **per reseller**, shared by every tenant you serve. `orderStatusWrite` is a
> question of data authority — may your events rewrite a column the tenant's staff
> see and edit in the CRM — and is stored **per tenant**. A mode change must never
> silently start rewriting customer-visible order status for all of your tenants at
> once, so choosing `receive_and_send` does **not** imply this flag. The one
> combination that is refused is the incoherent one: turning it on under a mode that
> delivers you no orders (§1.1).

By default this updates only the **integration** status — the customer-facing order
status is not rewritten. Set `"orderStatusWrite": true` at connect time and your
`order.status` events also move it, using the third column above.

Two rules govern that write, and both matter for how you sequence your events:

- **Fulfilment progress only ever advances.** The ladder is
  `draft → pending → confirmed → processing → shipped → delivered`. A rung *below*
  where the order already sits is treated as a late or reordered event and ignored,
  so you cannot rewind an order by re-sending an older transition.
- **`cancelled` and `refunded` apply from anywhere**, at any time — including after
  `shipped` or `delivered`. An order the customer refused on delivery is an ordinary
  outcome, not a stale event, and is never filtered out as "backward".

Sending a fulfilment step for an order WeAreDA already holds as `cancelled` or
`refunded` is treated as a **contradiction**, not an update: the order is left
untouched, its `integration_status` becomes `manual_review`, and the operation is
rejected with `order_status_conflict` for a human to resolve. We do not decide which
of the two systems is right.

When the status does move, it fires the same downstream effects a manual change in
the CRM would — alert notifications and conversation-lifecycle automation — so the
tenant's team sees the transition instead of it landing silently. `shipped_at` /
`delivered_at` are filled in if blank, and never overwritten if already set.

> **`order.status` never changes stock.** `fulfilled` / `shipped` / `delivered`
> tell us where the order is in *your* fulfilment process; they say nothing about
> quantities on hand, and WeAreDA does not decrement, reserve, or restore anything
> when it receives one. Stock only moves on a `stock.updated` (§6.2).

Notes:

- Send one event **per transition**, as the order progresses — `accepted`, then
  `shipped`, then `delivered`, each as its own request with its own event id.
- Reaching `completed` is not final in our model in the sense of blocking later
  events: a subsequent `cancelled` still applies. Re-sending the same state is
  harmless (it sets the same value).
- We never guess. A `state` outside the table above is **not mapped**: the event
  itself is parked for a human to inspect and the order's `integration_status` is
  **left exactly as it was** — we do not fall back to `manual_review` on the order.
  The same applies when the `external_order_id` / `order_number` you sent matches no
  order of ours.

### 6.2 `stock.updated` — authoritative stock

Push absolute quantities for reseller-owned products (matched by the external ids
you sent in `/products`).

```json
{
  "type": "stock.updated",
  "id": "evt_a13…",
  "items": [
    { "external_product_id": "P-1001", "quantity": 37 },
    { "external_variant_id": "V-1",   "quantity": 5 }
  ]
}
```

**The rules, exactly:**

- **`quantity` is the new ABSOLUTE on-hand** — a non-negative integer, **never a
  delta**. `37` means "there are 37", not "add 37". `0` is a valid value and means
  sold out; it is applied, not ignored. Because quantities are absolute, replaying
  the same event converges on the same state.
- **One event may carry many lines.** `items` can mix any number of products *and*
  variants in a single request. **There is no requirement to send one webhook per
  product** — batching every affected item into one `stock.updated` is the intended
  usage and the cheapest for both sides.
- **Line resolution**, most specific first:
  1. `external_variant_id` → the mapped variant,
  2. `external_product_id` → the mapped product,
  3. `sku` → last resort, matched **only** against products/variants already mapped
     to your connection, and only when it matches **exactly one** of them (an
     ambiguous sku is skipped rather than guessed).
  A line needs one of those three plus a valid `quantity`.
- **Partial application is by design.** A line that resolves to nothing, or carries
  an invalid quantity, is **skipped and counted**; every other line in the event
  still applies, and the event is not failed or retried because of it. Only an event
  with **no usable line at all** is parked for a human (nothing is applied).
- **A stock movement is recorded for audit.** `stock_movements.quantity` is a
  *movement*, so we derive it: the delta against the previous on-hand, written as
  `adjustment_in` (increase) or `adjustment_out` (decrease), with `stock_after` set
  to the absolute quantity you sent. A line that doesn't actually change the
  quantity writes no movement row.
- **Only reseller-owned products are touched**, resolved through the mapping built
  by the `/products` sync — a `stock.updated` can never reach a product that isn't
  yours.
- **Nothing about any order is read or written on this path**, whatever caused the
  inventory change.

Stock also arrives through the periodic `GET /products` pull (§4.2), which carries
the same absolute semantics. `stock.updated` is the push version, for when you want
us to know sooner than the next sync.

### 6.3 `invoice.issued` — invoice / fulfilment document  *(gated on: ordersWrite)*

Notify WeAreDA of an invoice for an order; optionally include a `documentUrl` we
fetch and store.

```json
{
  "type": "invoice.issued",
  "id": "evt_inv_7…",
  "invoice": {
    "external_invoice_id": "INV-2026-000123",
    "number": "A-0007",
    "status": "paid",                         // issued | paid | cancelled | void
    "currency": "USD",
    "total": 105.00,
    "issued_at": "2026-07-20T10:00:00Z",
    "external_order_id": "SO-88771",          // or our order id / order_number — see 6.3.1
    "document_url": "https://files.your-erp.com/inv/INV-2026-000123.pdf"
  }
}
```

- `document_url` (if present) must serve a **PDF** and be reachable over HTTPS;
  WeAreDA fetches it (size-capped) and stores a private copy. If the fetch fails
  the invoice is still recorded (document marked `failed`).
- Re-sending the same `external_invoice_id` **updates** the invoice in place
  (idempotent upsert).
- Ingest is gated on the **`ordersWrite`** capability, not on a separate `invoices`
  flag: `invoices` is not yet enabled at the platform capability ceiling, so it is
  reported `false` in `effectiveCapabilities` even while invoice events are accepted.
- Recording an invoice **does not move the order's status** and **does not touch
  stock** — it only attaches the invoice (and, if given, its stored PDF) to the order.

#### 6.3.1 Linking an invoice (or an `order.status`) to the right order

An inbound event names its order with **one** of three refs, tried in this order:

| # | Field | Matched against | Available when |
|---|-------|-----------------|----------------|
| 1 | `external_order_id` | `external_order_id` we stored on delivery, scoped to you + the tenant | **push mode only** — we set it from your `POST /orders` response body (§4.3) |
| 2 | `external_order_id` carrying **our** order UUID | our own order `id` | **always** — including pull mode |
| 3 | `order_number` | our `order_number` | always (we send it in `POST /orders`; it is also in the orders list and detail) |

**If you PULL orders instead of receiving them** (§11, `GET .../orders`), ref 1 does
not exist for you: nothing stamps `external_order_id` when we never POST the order to
you, and an `order.status` event does not stamp it either. Send **ref 2** — the `id`
straight from the orders list — or `order_number`. Both are in the list payload, so
no detail round-trip is needed.

> [!WARNING]
> An invoice whose ref matches **no** order is still ingested, with its
> `order_id` left empty — it appears in the customer's invoice list but **not** on
> the order. This is deliberate (an invoice may legitimately precede its order), so a
> wrong ref fails **silently**. `order.status`, in contrast, is rejected outright with
> `order_not_found`. Re-sending the invoice with the same `external_invoice_id` and a
> correct ref links it in place (idempotent upsert) — there is no automatic backfill.

To find orders still awaiting an invoice, poll `GET .../orders?hasInvoice=false`.

### 6.4 Orders and stock are independent flows

This is the single most important rule in this document, so it is stated on its own.

**WeAreDA must not, and does not, infer stock from orders.** No order event — created,
confirmed, sent, `accepted`, `cancelled`, `refunded`, `fulfilled`, `shipped`,
`delivered` — reserves, decrements, increments, or restores a single unit of
reseller-owned stock. **Your system is the authoritative source of truth for stock.**

An order will very often *cause* stock to change on your side. That recalculation is
**your internal responsibility**, and it reaches WeAreDA only when you publish the
result as a `stock.updated` event. Stock also changes for reasons that have nothing
to do with us — a purchase order arriving, a sale in your own shop, a stock count, a
write-off — and those use **exactly the same mechanism**. WeAreDA simply applies the
authoritative quantities you send, whatever their cause.

**Flow A — order delivery**

```
Order reaches the trigger status in WeAreDA
   │
   ▼   integration_status = pending      queued — nothing sent to you yet
   │
   ▼   integration_status = sending      the call is in flight
   │
   ├── POST /orders ──────────────────▶  your ERP
   │                                        │
   ◀────────── 201 { "id": "SO-88771" } ────┘
   │
   ▼   integration_status = accepted     external_order_id = "SO-88771"
   ⋮
   ⋮   (later, as your fulfilment progresses — a SEPARATE request)
   │
   ◀── POST order.status { "state": "shipped" }
   │
   ▼   integration_status = completed
```

**Flow B — inventory change**

```
Stock changes in your ERP
   (because of that order, a supplier delivery,
    a manual count, a sale in your own store, …)
   │
   ▼   you recalculate your own inventory     your system, your rules
   │
   ├── POST stock.updated ────────────────▶  WeAreDA
   │     { "items": [ { "external_product_id": "P-1001", "quantity": 37 },
   │                  { "external_variant_id": "V-1",    "quantity":  5 } ] }
   │
   ▼   stock_quantity := 37 and 5            absolute values, applied as sent
       + one audit movement per changed line
```

**These are two separate flows even when the same order caused both.** A reseller
handling one of our orders typically does:

1. Receive `POST /orders`.
2. Create/update the order in its ERP.
3. Return `200/201` with its external order id → we mark the order **`accepted`**.
4. Recalculate inventory internally.
5. `POST` **one** `stock.updated` webhook containing **all** affected products and
   variants → stock is **synchronized**.
6. Later, `POST` separate `order.status` events as the order progresses
   (`shipped`, `delivered` → **`completed`**).

Steps 3 and 5 are different HTTP requests with different event ids, and neither one
implies the other: an order can be `accepted` with no stock event ever arriving, and
a `stock.updated` can arrive with no order involved at all.

| WeAreDA sees | Order `integration_status` | Reseller-owned stock |
|---|---|---|
| `POST /orders` returns `201` | → `accepted` | unchanged |
| `order.status: fulfilled` | → `completed` | unchanged |
| `order.status: cancelled` | → `cancelled` | unchanged |
| `POST /orders/{id}/cancel` returns `2xx` | → `cancelled` | unchanged |
| `stock.updated` | unchanged | → set to the absolute quantities |


### 6.5 `product.updated` — catalog push  *(capability: productsRead)*

Send us your catalog instead of waiting to be polled. The items are **exactly the
product objects your `GET /products` would return** (§4.2) — same fields, same
`sync_config.products.fieldMap` overrides — so you can reuse one serializer for both
transports, or implement only this one and never build the read endpoint.

```json
{
  "type": "product.updated",
  "id": "evt_prod_5…",
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
      "images": ["https://…/a.jpg"],
      "updated_at": "2026-08-25T12:00:00Z",
      "variants": [
        { "id": "V-1", "sku": "WIDGET-BLK-S", "name": "Small",
          "attributes": {"size":"S"}, "price": 4999, "stock": 10 }
      ]
    }
  ]
}
```

**The rules, exactly:**

- **`products` is a batch.** Send every product that changed in one event — up to
  **500 per request**, and within the **512 KB** body limit. A larger batch is
  refused with `400 too_many_items` rather than silently truncated; page it the way
  you would page `GET /products`.
- **Upsert by `id`** (your `external_product_id`). Unknown → created; known →
  updated; variants are matched by their own `id` within the product.
- **Same engine as the pull.** Identical ownership rules, identical change
  detection: a product whose content is unchanged is a no-op, and a product whose
  `updated_at` is **older** than what we hold is ignored as stale — so a redelivered
  or out-of-order push cannot corrupt the catalog.
- **Reseller-owned fields only.** We write name, description, sku, price,
  compare-at, cost, currency, stock, status and images. The tenant's own overlay —
  AI description, bot visibility, internal category/tags — is never touched.
- **`stock` in a product payload is applied** like any other reseller-managed field.
  For a pure inventory change prefer `stock.updated` (§6.2): it is smaller, and it
  writes the stock-movement audit trail. A product push is for catalog changes.
- **Partial by nature — nothing is archived.** A push says "here is what changed",
  never "here is everything I have". WeAreDA therefore **never archives** a product
  just because it was absent from a batch, and **never advances the pull cursor**.
  To retire a product, send it with **`"status": "archived"`**.
- **Malformed items are skipped, not fatal.** An item without an `id` or a `name` is
  counted and dropped; the rest of the batch still applies.

**Removing a product:**

```json
{ "type": "product.updated", "id": "evt_prod_6…",
  "products": [ { "id": "P-1001", "name": "Black Widget", "status": "archived" } ] }
```

Archived products disappear from the AI agent's answers while staying visible and
auditable in the CRM.

**Push mode.** Choosing an `integrationMode` that does not read — `receive_and_send`
or `receive_only` (§1.1) — additionally tells WeAreDA to stop pulling you: no schedule is created, no `GET /products` call is
ever made, and no archive-missing sweep can run. Leaving it at the default
`query_and_send` keeps the scheduled sync **and** still accepts pushes — useful as an
accelerator, so a price change shows up in seconds instead of at the next sync.

| | modes that read (`query_*`) | modes that do not (`receive_*`) |
|---|---|---|
| `GET /products` | required, called on a schedule | never called — you need not implement it |
| `product.updated` | accepted (accelerator) | accepted (the only catalog source) |
| Archive-missing sweep | yes, on full/reconciliation pulls | never — use `status: "archived"` |
| Sync cursor | advances on a successful pull | unused |

---

## 7. Per-integration overrides (`sync_config`)

If your system's paths/params differ from the defaults, send `syncConfig` in the
`connect` body (§2). Defaults shown:

```json
{
  "integrationMode": "query_and_send",          // see §1.1 — prefer setting this at the
                                                //   TOP LEVEL of the connect body
  "products": {
    "mode": "pull",                             // derived from integrationMode; do not set
                                                //   it to a contradictory value
    "path": "/products", "pageParam": "page", "pageSizeParam": "limit",
    "sinceParam": "updated_since", "pageSize": 200,
    "itemsKey": null,                          // explicit array key, else auto-detect
    "fieldMap": { "id": "sku_id", "name": "title" }   // override any field mapping
  },
  "orders": {
    "path": "/orders", "idempotencyHeader": "Idempotency-Key",
    "orderIdField": "id",                       // where your order id is in the response
    "requiresTaxId": false                      // §4.3.2 — true = never send an order whose
                                                //   customer has no fiscal identifier
  },
  "documentHosts": ["files.your-erp.com"],     // extra allow-listed hosts for invoice PDFs
  "enabled": true,                              // false disables the scheduled sync
  "frequency": "daily"                          // hourly | daily | weekly
}
```

**Validation.** The blob is checked against a strict whitelist before it is stored —
it steers outbound request construction and the invoice-document host allow-list, so
it is not free-form. An invalid config fails the connect with
`400 invalid_sync_config` and a message naming each offending key. In particular:

| Key | Accepted |
|---|---|
| `products.mode` | `pull` or `push` |
| `*.path` | a **relative** path starting with `/` — no scheme, host, or `..` |
| `pageParam`, `pageSizeParam`, `sinceParam`, `itemsKey`, `orderIdField`, `fieldMap` keys/values | short alphanumeric field names (≤ 64 chars) |
| `products.pageSize` | integer 1–500 |
| `orders.idempotencyHeader` | a valid HTTP header name |
| `orders.requiresTaxId` | a boolean (default `false` — see §4.3.2) |
| `documentHosts` | up to 10 **bare hostnames** (`files.your-erp.com`) — never a URL, port, or path |
| `frequency` / `scheduleExpression` | `hourly\|daily\|weekly`, or a `rate(…)` / `cron(…)` expression |

Unknown sections or options are **rejected**, not silently ignored, so a typo
surfaces at connect time instead of looking like a feature that does not work. The
stored result is echoed back in the `connect` and `status` responses.

---

## 8. Statuses reference

**Order `integration_status`** (what WeAreDA tracks per order — this is *not* the
customer-facing order status, which moves only under the `orderStatusWrite` opt-in
of §6.1, and **none of these values implies a stock effect**):

| Value | Meaning | Set by |
|---|---|---|
| `pending` | queued for delivery, nothing sent yet | WeAreDA (order reached the trigger status) |
| `sending` | a `POST /orders` attempt is in flight | WeAreDA |
| `accepted` | you returned `2xx` (id stored as `external_order_id` when present) | your `POST /orders` response |
| `completed` | you reported fulfilled / completed / shipped / delivered | your `order.status` event |
| `returned` | you reported returned / refunded / not_delivered — it shipped and came back | your `order.status` event |
| `failed` | retries exhausted on a transient error | WeAreDA |
| `rejected` | non-retryable refusal (e.g. the order was already cancelled here) | WeAreDA |
| `manual_review` | needs a human (auth failure, unknown `state`, unresolvable order) | WeAreDA |
| `cancel_pending` | a cancellation is queued for you | WeAreDA |
| `cancelled` | cancellation confirmed (`POST …/cancel` `2xx`, or your `order.status: cancelled`) | either direction |
| `cancel_failed` | cancellation retries exhausted | WeAreDA |

Happy path: `pending → sending → accepted → completed`.
Cancellation arc: `cancel_pending → cancelled` (or `cancel_failed`).

**Stock** has no status of its own — it is a quantity, replaced wholesale by the last
authoritative value you sent (`stock.updated`, or the `/products` pull).

**Invoice `status`:** `issued | paid | cancelled | void`.
**Invoice `document_status`:** `none | stored | failed`.

---

## 9. Security & operational notes

- **Outbound** requests only ever go to your registered **https** `base_url` host
  (and allow-listed `documentHosts` for invoice PDFs). Redirects are re-validated
  each hop; private/internal addresses are refused (SSRF hardening).
- **Inbound** is authenticated solely by the HMAC signature — the URL is not a
  secret, the signature is. Rotate the `webhookSecret` by re-connecting.
- WeAreDA never logs your credentials or raw request/response bodies. **Customer
  fiscal identifiers are masked** (`20-******78-9`) wherever they appear in an
  operational log, and are never written to an audit record in full.
- **Compatibility.** This contract is **not versioned by URL**; it evolves additively
  and every consumer must ignore fields it does not know. The `customer` object and
  its `tax_id` (§4.3) were added that way — no existing field was renamed, removed,
  or given a new meaning, so an integration written before them keeps working
  unchanged and no version bump was warranted. A breaking change would get a new
  path, not a silent redefinition.
- Timeouts: outbound calls use a bounded timeout (≤ 60 s; ~10–15 s typical) — your
  endpoints should respond well within that or return `202`-style fast acks and do
  heavy work async on your side.

---

## 10. Quick checklist for your implementation

- [ ] `GET /` returns `2xx` with valid credentials.
- [ ] Your catalog reaches us one of two ways — **either** `GET /products` returns it
      (array or wrapped), paginated, honoring `updated_since`, **or** you set
      `products.mode: "push"` and POST `product.updated` batches (§6.5).
- [ ] If you push: batches are ≤ 500 products, you retire a product with
      `status: "archived"`, and you do **not** expect us to archive what you omit.
- [ ] `POST /orders` is **idempotent** on `Idempotency-Key` (return `409`/same order
      on repeat) and **returns your order id** on the first `2xx`.
- [ ] `POST /orders/{id}/cancel` treats unknown/already-cancelled as success, and you
      publish any resulting restock as a separate `stock.updated`.
- [ ] You POST signed `order.status`, `stock.updated`, `product.updated` and (if
      enabled) `invoice.issued` events to your `webhookUrl`, with stable
      `X-WeAreDA-Event-Id`s.
- [ ] **One event type per HTTP request** — never `order.status` and `stock.updated`
      in one body, never a batch envelope.
- [ ] Your `stock.updated` quantities are **absolute**, and one event carries **all**
      the products/variants affected by the change.
- [ ] You send a `stock.updated` after any inventory change — whether an order caused
      it or not. You do **not** assume WeAreDA adjusted stock from the order itself.
- [ ] You verify our outbound credentials and we verify your inbound signature.
- [ ] You accept an **unknown `customer.tax_id.type`** (it is a free token, not an
      enum) and you tolerate `customer` / `customer.tax_id` being absent or `null`.
- [ ] If you cannot invoice without a fiscal id, you set
      `syncConfig.orders.requiresTaxId: true` (§4.3.2) rather than rejecting orders.

---

## 11. Reseller read API — tenant orders (WeAreDA → you, on demand)

> **Different plane from §4–§6.** Sections 4–6 are the *connector* data contract
> (WeAreDA calls your commerce system; you call our HMAC webhook). This section
> is a **management/read API you call on our backend** to inspect the orders that
> belong to one of your tenants. It is authenticated by your **`X-Reseller-Key`**
> (the same key used for tenant provisioning — see `RESELLER_INTEGRATION_GUIDE.md`),
> **not** by the HMAC connector signature, and it uses `X-Reseller-Key`, **never**
> `X-Tenant-Id` — the tenant is taken from the path and must belong to you.

### 11.1 Authentication & authorization

Every request carries your API key:

```http
X-Reseller-Key: rsk_...
```

Each request is validated, in order:

1. The API key is valid and the reseller is **active**.
2. The reseller holds the **`canViewTenantOrders`** permission (see §11.7).
3. The `{tenantId}` in the path **exists** and **belongs to you**.
4. For a single order, the order **belongs to that tenant** (enforced in the SQL,
   not after fetch) — so cross-reseller and cross-tenant reads are impossible.

### 11.2 Endpoints

```http
GET /api/v1/resellers/me/tenants/{tenantId}/orders
GET /api/v1/resellers/me/tenants/{tenantId}/orders/{orderId}
GET /api/v1/resellers/me/tenants/{tenantId}/orders/{orderId}/invoices
GET /api/v1/resellers/me/tenants/{tenantId}/invoices/{invoiceId}/document
```

curl (no real credentials/ids):

```bash
curl \
  -H "X-Reseller-Key: rsk_example" \
  "https://api.example.com/api/v1/resellers/me/tenants/TENANT_ID/orders?status=confirmed&limit=25"
```

### 11.3 List — filters & pagination

**Filters** (all optional, combined with AND; unknown values → `400 invalid_filter`):

| Query param | Notes |
|---|---|
| `status` | one of `draft, pending, confirmed, processing, shipped, delivered, cancelled, refunded` |
| `paymentStatus` | one of `unpaid, pending, paid, partial, refunded, failed` |
| `integrationStatus` | one of `pending, sending, accepted, failed, rejected, manual_review, completed, cancel_pending, cancelled, cancel_failed` |
| `externalOrderId` | exact match on the id in your system |
| `customerId` | internal contact UUID |
| `email` | customer email (case-insensitive, exact) |
| `createdFrom`, `createdTo` | ISO-8601 bounds on creation time |
| `updatedFrom`, `updatedTo` | ISO-8601 bounds on last update |
| `hasInvoice` | `true` / `false` |
| `search` | ≥ 2 chars; tenant-scoped `ILIKE` over order number, external order id, customer name/email/phone, invoice number |

**Pagination** — opaque **keyset cursor**, newest-first, stable:

- `limit` — default **25**, max **100**.
- `cursor` — pass back `pagination.nextCursor` from the previous page. It encodes
  only the `(created_at, id)` sort position (base64url) — no internal detail, and a
  tampered/invalid cursor returns **`400 invalid_cursor`**. Resend the same filters
  alongside the cursor; ordering stays stable.

List response:

```json
{
  "items": [
    {
      "id": "order-uuid",
      "tenantId": "tenant-uuid",
      "externalOrderId": "external-order-123",
      "orderNumber": "ORD-ABC",
      "status": "confirmed",
      "paymentStatus": "paid",
      "integrationStatus": "completed",
      "currency": "ARS",
      "subtotal": 10000,
      "discount": 0,
      "tax": 2100,
      "shipping": 0,
      "total": 12100,
      "customer": {
        "id": "customer-uuid", "name": "Juan Pérez", "email": "juan@example.com", "phone": "+549...",
        "taxId": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
      },
      "itemsCount": 2,
      "invoiceCount": 1,
      "createdAt": "2026-07-28T12:00:00Z",
      "updatedAt": "2026-07-28T12:05:00Z"
    }
  ],
  "pagination": { "nextCursor": "eyJ...", "hasMore": true }
}
```

Order **items are not included in the list** — request the detail endpoint.

### 11.4 Detail

```json
{
  "id": "order-uuid",
  "tenantId": "tenant-uuid",
  "externalOrderId": "external-order-123",
  "orderNumber": "ORD-ABC",
  "status": "confirmed",
  "paymentStatus": "paid",
  "integrationStatus": "completed",
  "currency": "ARS",
  "subtotal": 10000, "discount": 0, "tax": 2100, "shipping": 0, "total": 12100,
  "customer": {
    "id": "customer-uuid", "firstName": "Juan", "lastName": "Pérez", "name": "Juan Pérez",
    "email": "juan@example.com", "phone": "+549...",
    "taxId": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
  },
  "billingAddress": { "line1": "…", "city": "…", "state": "…", "postalCode": "…", "country": "…" },
  "shippingAddress": { },
  "items": [
    { "id": "order-item-uuid", "productId": "product-uuid", "variantId": null, "sku": "SKU-123", "name": "Product name", "variantName": null, "quantity": 2, "unitPrice": 5000, "discount": 0, "subtotal": 10000 }
  ],
  "integration": {
    "status": "completed",
    "externalReference": "external-order-123",
    "attempts": 1,
    "lastAttemptAt": "…",
    "completedAt": "…",
    "lastErrorCode": null
  },
  "invoices": [
    { "id": "invoice-uuid", "externalInvoiceId": "invoice-ext-123", "number": "0001-00001234", "status": "issued", "currency": "ARS", "total": 12100, "issuedAt": "…", "documentStatus": "stored", "documentAvailable": true }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

Fields are only present when they exist in the model — amounts and tax are never
fabricated. `documentType`/`documentNumber` are **not** stored and are omitted.

### 11.5 Integration status

`integration` is a **safe projection** of the order's delivery lifecycle (§8) plus
its latest `ORDER_DELIVERY` / `ORDER_CANCEL` operation. It is `null` for a purely
local order that was never handed to an integration. A failed operation exposes a
stable **`lastErrorCode`** only. Never exposed: raw connector request/response
bodies, full error messages, retry internals, credentials, or operation context
(which may contain customer PII). A missing/disconnected integration does not hide
historical orders — they remain listable and viewable.

### 11.6 Invoices & document access

`orders/{orderId}/invoices` returns the same safe invoice projection embedded in
the detail. `invoices/{invoiceId}/document` returns a **short-lived presigned URL**
(reusing the tenant-scoped S3 guard), scoped to your tenant:

```json
{ "document_url": "https://…", "kind": "stored", "mime": "application/pdf" }
```

The S3 **bucket/key is never returned**, nor is a long-lived direct URL. A missing
document returns a controlled `404`.

### 11.7 Permissions & errors

Gated by the reseller permission flag **`canViewTenantOrders`** (defaults **on** for
existing resellers; a platform admin can revoke it). Errors use the stable reseller
error model:

| HTTP | `reason` | When |
|---|---|---|
| 401 | `invalid_reseller_key` | missing/invalid `X-Reseller-Key` |
| 403 | `reseller_disabled` | reseller account disabled |
| 403 | `orders_permission_denied` | `canViewTenantOrders` not granted |
| 403 | `tenant_ownership_mismatch` | tenant belongs to another reseller |
| 404 | `tenant_not_found` | unknown tenant id |
| 404 | `order_not_found` | order not in this tenant (existence not leaked) |
| 400 | `invalid_filter` | bad filter value |
| 400 | `invalid_cursor` | malformed/tampered cursor |
| 500 | `internal_error` | unexpected failure (no DB/provider detail leaked) |

### 11.8 Privacy & auditing

- **List** exposes a minimal customer (display name, email, phone, `taxId`). **Detail**
  may add billing/shipping address and fulfilment contact details. Never exposed:
  internal notes, contact custom fields, Cognito/auth identifiers, conversation
  history, payment tokens/provider payloads, S3 keys, or infrastructure identifiers.
- **Fiscal identifiers are sensitive customer data.** They are visible only to the
  reseller that owns the tenant (the same isolation as every other order field), and
  they are **never written to an operational log in full** — our logs carry a masked
  form (`20-******78-9`) or nothing at all. Treat them the same way on your side.
- Successful reads are **not** written to the reseller audit log (consistent with the
  platform's other reseller read endpoints and to avoid high-volume audit noise);
  authorization failures and the invoice-document download **are** audited
  (`reseller.invoice.document_requested`). Every request emits a structured, PII-free
  log line (reseller id, tenant id, order id, correlation id, filter **names**,
  duration, result count, sanitized error code).
