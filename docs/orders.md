# Orders

Contract §4.3 (delivery), §4.4 (cancellation) and §6.1 (`order.status`).

> Nothing on this page changes stock. Not delivery, not acceptance, not
> completion, not cancellation. See [stock.md](stock.md).

> **Orders only reach you at all in an `integrationMode` that delivers them** —
> `query_and_send` or `receive_and_send`. Under `query_only` / `receive_only`,
> `ordersWrite` is off in the effective capabilities and nothing is ever queued.
> See [integration-modes.md](integration-modes.md).

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
| — | `returned` | You reported `returned` / `refunded` / `not_delivered`: it shipped and came back. **Not** a cancellation. |

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
2. **The `customer` object is optional in two independent ways, and its
   `tax_id.type` is a free token, not an enum.** `customer` is omitted entirely
   when the order has no contact; `customer.tax_id` is `null` when the contact
   has no fiscal identification; and the values are a *snapshot* taken when the
   order was created, not a live read of the contact. See
   [The customer and its fiscal id](#the-customer-and-its-fiscal-id) below.

Beyond that, nothing you do not need to fulfil and invoice the order is sent —
no internal notes, no contact custom fields, no payment tokens.

The item ids (`external_product_id`, `external_variant_id`) are the ids **you**
gave WeAreDA in `/products`.

---

## The customer and its fiscal id

Contract §4.3, added 2026-09. Purely **additive**: no field was renamed, removed
or given a new meaning, the contract was **not** versioned for it (§9), and an
integration written before it keeps working untouched. Do not make any of it
required.

```json
"customer": {
  "id": "contact-uuid",
  "name": "Ada Lovelace",
  "first_name": "Ada", "last_name": "Lovelace",
  "email": "ada@example.com",
  "phone": "+541112345678",
  "tax_id": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
}
```

| Case | On the wire | What it means |
|---|---|---|
| the order has no contact | **no `customer` key at all** | an ordinary order |
| the contact has no fiscal id | `"tax_id": null` | an ordinary order |
| the contact has one | `{ type, value, country }` | invoice against this |

`tax_id` is **always present inside `customer`**, so you can branch on it
without optional-chaining gymnastics — `null` is a real answer, not an absence.

### `tax_id.type` is a free short token, not an enum

`CUIT`, `CUIL`, `DNI`, `CPF`, `CNPJ`, `NIF`, `NIE`, `CIF`, `RFC`, `EIN`, `SSN`,
`VAT`, `TAX_ID` — and whatever the next country uses. **Meeting a value you have
never seen is normal.** Store it verbatim; never normalise it into a token you
do recognise, never validate it against a list of "known" types, and never
reject the order over it. `tax_id.country` is ISO 3166-1 alpha-2.

`tests/orders.test.ts` pins this with an Icelandic `KENNITALA`, precisely so
that adding an enum later fails the suite.

### It is a snapshot, not a live read

The values were copied onto the order **when it was created** (§4.3.1). If the
tenant corrects the contact tomorrow, an order you already received — and
possibly already invoiced — keeps the identity it was created with; only new
orders carry the new value. An invoice is issued against a fiscal identity, and
that identity must not change retroactively, so **never "correct" a stored order
from a later read** of the customer.

One exception, in your favour: an order that arrived with **no** fiscal id may
later report one, because WeAreDA fills that gap from the contact. The snapshot
freezes a *value*, not an *absence*.

### If you cannot invoice without one

Set `syncConfig.orders.requiresTaxId: true` on the integration (§4.3.2, §7) —
it is reseller-wide, like the rest of `syncConfig`:

```bash
npm run cli -- integration:create --requires-tax-id
# already created? it is one PATCH:
npm run cli -- integration:patch --sync-config '{"orders":{"requiresTaxId":true}}'
```

WeAreDA then **never delivers** an order whose customer has no fiscal id — it is
simply not yet eligible — and delivers it automatically, within a minute, once
the tenant completes the contact. Nothing is parked and nothing has to be
re-queued. Default is `false`, which is what every existing integration keeps.

> **The lesson.** A reseller that cannot invoice without a fiscal id sets *that
> flag*. It does **not** reject orders on arrival: a non-auth `4xx` is not
> retried, so rejecting turns an order that would have arrived complete into a
> manual-review ticket.

### Treat it as sensitive

A fiscal identifier is sensitive customer data. WeAreDA masks it in its
operational logs (`20-******78-9`) and §11.8 asks you to do the same. This
sandbox prints full bodies on purpose — and makes this the one deliberate
exception:

| Where | What you see |
|---|---|
| the request log, `GET /debug/events`, `GET /debug/orders` | `20-******78-9` |
| the CLI, including `invoice` and `orders:list` | `20-******78-9` |
| the stored order (`orders.customer_tax_id`, `payload`) | the real value |

The store keeps the real value because you cannot invoice against a masked one.
Everything that *renders* an order masks it, via `maskTaxId` / `maskTaxIds` in
[`src/lib/redact.ts`](../src/lib/redact.ts).

### It changes no behaviour

The customer object is data. It does not gate acceptance, it does not move a
status, and — like everything else on this page — it does not touch stock
(§6.4). See [stock.md](stock.md).

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
- a `customer` that is present but not an object (a string, an array) — the only
  genuinely unusable shape

Everything else is accepted and stored verbatim. Be conservative here: a
non-auth `4xx` is **not retried**, so a strict validator turns a recoverable
hiccup into a manual-review ticket.

It explicitly does **not** reject: a missing `customer`, `customer.tax_id: null`,
a missing `tax_id` key, an unknown `tax_id.type`, or a `tax_id.value` in a format
it has never seen. A `tax_id` it cannot read is treated as *no fiscal id*, not as
a reason to send the order to a human.

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

### The mapping table has two columns

`integration_status` always moves. The **customer-facing** `orders.status` — the
column the tenant's staff see and edit in the CRM — moves only when the tenant
registered `orderStatusWrite: true` when that customer was attached
([integration-modes.md](integration-modes.md#orderstatuswrite)) — it is a
per-tenant setting, not a reseller-wide one.

| Your `state` (aliases) | → `integration_status` | → `orders.status` *(opt-in only)* |
|---|---|---|
| `accepted` / `acknowledged` / `ack` | `accepted` | `confirmed` |
| `shipped` / `fulfilled` | `completed` | `shipped` |
| `delivered` / `completed` | `completed` | `delivered` |
| `cancelled` / `canceled` | `cancelled` | `cancelled` |
| `returned` / `return` / `refunded` / `not_delivered` / `undelivered` | `returned` | `refunded` |
| `rejected` / `failed` / `error` | `manual_review` | *(unchanged)* |
| anything else | **not mapped** | *(unchanged)* |

Three things about that table are worth reading twice.

**`shipped` and `delivered` both collapse to `completed`.** So the customer-facing
status is derived from the **raw** `state` you sent, never from
`integration_status` — by the time WeAreDA holds a `completed`, it can no longer
tell the two apart.

**`fulfilled` maps to `shipped`, not `delivered`.** Deliberately the cheaper wrong
guess: the ladder below permanently discards a lower rung arriving later, so
guessing the top rung would throw away your real `delivered` event. Guessing the
lower one costs nothing — your `delivered` still lands.

**A return is not a cancellation.** `cancelled` means the order never shipped;
`returned` means it shipped and came back. WeAreDA keeps them apart, and a return
does **not** trigger a cancellation call back to you.

An unmapped state is not an error and not a `manual_review` on the order: the
operation is rejected with `unknown_order_state`, the event is parked for a
human, and the order's `integration_status` is left **exactly as it was**. The
same applies when the order reference matches nothing (`order_not_found`). Try
it:

```bash
npm run cli -- order-status SO-10001 packed_in_warehouse
```

### Transition rules — these are not obvious

They only apply to the second column, and only under the opt-in.

```
LADDER      draft → pending → confirmed → processing → shipped → delivered
            Only ever ADVANCES. A lower rung arriving after a higher one is a
            late or reordered event and is ignored, not applied.

EXCEPTIONS  cancelled, refunded
            Apply from ANY rung at ANY time — including after shipped/delivered.
            An order the customer refused on delivery is an ordinary outcome.
```

| current | incoming | result |
|---|---|---|
| any ladder rung | `cancelled` / `refunded` | applied |
| lower rung | higher rung | applied |
| higher rung | lower rung | **ignored** (late/duplicate event) |
| `cancelled` / `refunded` | any ladder rung | **conflict** — see below |

So you cannot rewind an order by re-sending an older transition, and you cannot
lose a cancellation by having shipped first.

A fulfilment step reported for an order WeAreDA already holds as
`cancelled`/`refunded` is a **contradiction between the two systems**, not an
update: the order is left untouched, its `integration_status` becomes
`manual_review`, and the operation is rejected with `order_status_conflict`.
Neither side wins automatically — a human resolves it.

When the status does move, it fires the same downstream effects a manual change
in the CRM would: alert notifications and conversation-lifecycle automation. The
two columns move in one atomic write. `shipped_at` / `delivered_at` are filled in
when blank and **never** overwritten.

### Operation result diagnostics

You see these on the **operation**, not in the webhook response — `202` only says
the event was queued. The stable `lastErrorCode` is what contract §11.5 exposes
through the read API's `integration` projection; the `result.detail` strings are
the human-readable half of the same record.

An `order.status` operation that completes reports why the customer-facing status
did or did not move, in `integration_operations.result.detail`:

| `detail` | meaning |
|---|---|
| `completed; status confirmed→shipped` | moved; alert + lifecycle fired |
| `completed; status unchanged (status_write_disabled)` | `orderStatusWrite` is off |
| `completed; status unchanged (unmapped_state)` | the state has no customer-facing meaning (`rejected` / `failed` / `error`) |
| `completed; status unchanged (already_current)` | the order was already there |
| `completed; status unchanged (backward)` | late event, discarded by the ladder |

Terminal failures surface instead as `last_error_code`:

| `last_error_code` | cause |
|---|---|
| `unknown_order_state` | the `state` is not in the mapping table |
| `order_not_found` | the `external_order_id` / `order_number` matches no order |
| `order_status_conflict` | a fulfilment step on an order held as cancelled/refunded |
| `integration_disabled` | the integration is disconnected or disabled |
| `read_calls_disabled` | a read was attempted in a `receive_*` mode |
| `order_delivery_disabled` | an order operation in a `query_only` / `receive_only` mode |

### Worked example — the full sequence

Two sequences, both against `SO-10001`, whose `orders.status` starts at
`confirmed`. Every request needs its **own** event id.

```json
{ "type": "order.status", "id": "evt_1", "order": { "external_order_id": "SO-10001", "state": "accepted" } }
{ "type": "order.status", "id": "evt_2", "order": { "external_order_id": "SO-10001", "state": "shipped" } }
{ "type": "order.status", "id": "evt_3", "order": { "external_order_id": "SO-10001", "state": "delivered" } }
```

| event | `integration_status` | `orders.status` (opt-in ON) | `result.detail` |
|---|---|---|---|
| `accepted` | `accepted` | confirmed *(unchanged)* | `completed; status unchanged (already_current)` |
| `shipped` | `completed` | **shipped** | `completed; status confirmed→shipped` |
| `delivered` | `completed` | **delivered** | `completed; status shipped→delivered` |

With the opt-in **off**, the middle column never moves and all three report
`completed; status unchanged (status_write_disabled)`.

And an exception applying after shipping:

```json
{ "type": "order.status", "id": "evt_4", "order": { "external_order_id": "SO-10001", "state": "shipped" } }
{ "type": "order.status", "id": "evt_5", "order": { "external_order_id": "SO-10001", "state": "returned" } }
```

| event | `integration_status` | `orders.status` (opt-in ON) | `result.detail` |
|---|---|---|---|
| `shipped` | `completed` | **shipped** | `completed; status confirmed→shipped` |
| `returned` | `returned` | **refunded** | `completed; status shipped→refunded` |

The whole thing, narrated and runnable:

```bash
npm run scenario:order-status
npm run cli -- order-status SO-10001 returned --current shipped
```

Reaching `completed` does not block later events — a subsequent `cancelled` still
applies. Re-sending the same state is harmless; it reports `already_current`.
