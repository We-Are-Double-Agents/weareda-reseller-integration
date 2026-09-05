# Webhooks (Reseller -> WeAreDA)

Contract §3.2, §5 and §6.

One endpoint, four event types, one signature scheme.

> **Available in every `integrationMode`.** Inbound webhooks are not one of the
> two axes the mode splits (contract §1.1): a `receive_only` reseller that WeAreDA
> never calls still publishes all four event types, provided a `webhookSecret` is
> configured. The mode governs what WeAreDA does, not what you may send. See
> [integration-modes.md](integration-modes.md).

```http
POST {webhookUrl}
X-WeAreDA-Signature: sha256=<hex HMAC_SHA256(rawBody, webhookSecret)>
X-WeAreDA-Event-Id:  evt_…
X-WeAreDA-Timestamp: 1787693018
Content-Type: application/json
```

`webhookUrl` comes from the attach response for that customer (contract §2.2)
and looks like
`https://api.weareda.com/api/v1/reseller-webhooks/<connectionId>`. The URL is
not a secret — the signature is.

---

## Signing: the rule that breaks most integrations

> The signature is an HMAC-SHA256 over the **exact raw bytes of the body you
> send**.

So:

```js
const body = JSON.stringify(event);   // serialize ONCE
const sig  = hmac(body, webhookSecret);
await fetch(url, { method: 'POST', headers: { 'X-WeAreDA-Signature': `sha256=${sig}` }, body });
//                                                                                      ^^^^
//                                                            the SAME string, not a re-serialization
```

Never `JSON.stringify` again after signing. Key order, whitespace, number
formatting (`1.0` vs `1`), unicode escaping — any difference between the signed
string and the sent string produces `401 unauthorized`.

`src/weareda/webhook-client.ts` has exactly one `JSON.stringify` per event, and
passes that string straight to `fetch`. There is no path through the module
where the body could be rebuilt.

Verification on WeAreDA's side is constant-time over the untouched bytes. A
connection with no configured `webhookSecret` is rejected with `401` —
unauthenticated webhooks are never accepted.

`verifySignature()` is exported so you can check your own signing locally; the
test suite uses it to stand up a receiver that validates exactly as WeAreDA
does.

### Timestamp

`X-WeAreDA-Timestamp` is optional, in unix seconds or milliseconds, and must be
within a **±5 minute** replay window. Outside it: `401 stale_timestamp`, which
in practice almost always means the sending machine's clock is wrong.

---

## One event type per HTTP request

Contract §6.0. Every request carries exactly one top-level `type` and the one
payload container that belongs to it.

| `type` | Its payload container |
|---|---|
| `order.status` | `order` |
| `stock.updated` | `items` |
| `product.updated` | `products` |
| `invoice.issued` | `invoice` |

Correct — two events, two requests:

```json
{ "type": "order.status",  "id": "evt_1", "order": { "external_order_id": "SO-10001", "state": "fulfilled" } }
```
```json
{ "type": "stock.updated", "id": "evt_2", "items": [ { "external_product_id": "P-1001", "quantity": 37 } ] }
```

Rejected with `400 multiple_event_types` — one request carrying two types:

```json
{
  "type": "order.status",
  "order": { "external_order_id": "SO-10001", "state": "fulfilled" },
  "items": [ { "external_product_id": "P-1001", "quantity": 37 } ]
}
```

Also rejected with `400 multiple_event_types` — there is no batch envelope:

```json
{ "events": [ { "type": "order.status" }, { "type": "stock.updated" } ] }
```

A mixed payload is refused **whole**. WeAreDA never applies one half and
silently drops the other.

`type` must be top-level; an `{ "event": { "type": … } }` wrapper returns
`400 unsupported_event`.

**Batching *within* one type is expected**, and different from mixing types: one
`stock.updated` should carry every affected product and variant, and one
`product.updated` should carry every changed product.

In this repository the four builders in `src/weareda/events.ts` can only produce
one type each, and `assertSingleEventType()` re-checks before sending, with the
same error names WeAreDA would return.

---

## Responses

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "accepted": true, "operationId": "…" }` | **queued** |
| `200` | `{ "deduped": true, "operationId": "…" }` | duplicate event id — no-op |
| `400` | `{ "error": "unsupported_event" }` | unknown or missing top-level `type` |
| `400` | `{ "error": "multiple_event_types" }` | two types, or a batch envelope |
| `400` | `{ "error": "too_many_items", "max": 500 }` | `product.updated` over the cap |
| `401` | `{ "error": "unauthorized" }` / `{ "error": "stale_timestamp" }` | bad signature / outside the window |
| `404` | `{ "error": "not_found" }` | unknown or disconnected connection |

A connection with **no configured webhook secret** is never accepted
unauthenticated — it is always `401`, never a pass-through.

`202` only says the event was queued. What the queue then made of it shows up on
the operation: `result.detail` for one that completed, `last_error_code` for one
that failed. The `order.status` codes are tabulated in
[orders.md](orders.md#operation-result-diagnostics).

> **`202` means accepted, not applied.** Processing is asynchronous: effects
> land shortly after via WeAreDA's internal queue, under its own retry and DLQ.
> Each event is applied at most once — a redelivery inside WeAreDA's own
> infrastructure never doubles an effect or an audit row.

Do not treat `202` as confirmation that stock or an order status has changed.

---

## Event ids, dedup and retries

- Give each event a **stable id per real-world event** (so a retry of the same
  delivery repeats the id) and a **unique id across different events**.
- Dedup is scoped to *connection + event type + event id*. Reusing an id across
  types happens to work, but don't rely on it — just use distinct ids.
- A duplicate returns `200 {deduped: true}`.

### Where the event id comes from, and the trap in the last rung

WeAreDA resolves it in this order:

1. the `X-WeAreDA-Event-Id` header,
2. `body.event.id` / `body.eventId` / `body.id`,
3. **a content hash of the raw body.**

That third rung is the single most common cause of "I sent it and nothing
happened": **send the same payload twice with no distinct event id and the second
one dedups silently** — `200 {"deduped": true}`, and nothing is applied. No error,
no warning, no effect.

```bash
# Both of these send the identical body. The second changes nothing.
curl -X POST "$WEAREDA_WEBHOOK_URL" -H "X-WeAreDA-Signature: sha256=…" \
     -d '{"type":"order.status","order":{"external_order_id":"SO-10001","state":"shipped"}}'
```

Every sender in this repository generates a **fresh id per send** for exactly
that reason: the CLI and the event builders mint an `evt_…` per event
(`src/lib/ids.ts`), and the Postman pre-request scripts generate one per request.
The only place an id is reused is where reuse is the point — `--event-id`, and
folder 10's replay request.

Note that a top-level `id` is the **event** id, not the order id. The order
reference goes in `order.external_order_id` (preferred — the id you returned from
`POST /orders`) or `order.order_number` as a fallback.

This client retries only `5xx` and network failures, with exponential backoff,
**reusing the same event id and the same body** — which is exactly what lets
WeAreDA dedupe the retry. A `4xx` is a contract error on your side and is never
retried.

Watch dedup happen:

```bash
npm run cli -- stock P-1001 37 --event-id evt_replay_demo
npm run cli -- stock P-1001 37 --event-id evt_replay_demo    # 200 deduped: true
```

Every transition needs its own id, though — the CLI mints one per send:

```bash
npm run cli -- order-status SO-10001 accepted    # evt_a…
npm run cli -- order-status SO-10001 shipped     # evt_b…
npm run cli -- order-status SO-10001 delivered   # evt_c…
```

---

## Testing outbound events locally

Without `WEAREDA_WEBHOOK_URL` the CLI and scenarios run in **dry run**: the
event is built, validated and signed, and printed — but not sent. That is useful
before your integration is connected.

For a real round trip without WeAreDA, run the included stand-in:

```bash
npm run mock:weareda
```

```env
WEAREDA_WEBHOOK_URL=http://localhost:4000/api/v1/reseller-webhooks/demo-connection
WEAREDA_WEBHOOK_SECRET=whsec_example
```

It verifies the HMAC over the raw body and reproduces the response contract
above — including `deduped`, `multiple_event_types`, `too_many_items`,
`unsupported_event` and `stale_timestamp` — so you can see each outcome for
yourself. It is a development aid, not WeAreDA.

It also stands in for the WeAreDA side of an `order.status`: it applies the
ladder and the exceptions, and records the resulting operation.

```bash
curl -X POST http://localhost:4000/api/v1/mock/orders \
  -H 'content-type: application/json' \
  -d '{"external_order_id":"SO-10001","status":"confirmed"}'

npm run cli -- order-status SO-10001 shipped
curl http://localhost:4000/api/v1/mock/operations   # result.detail, last_error_code
curl http://localhost:4000/api/v1/mock/orders       # both status columns
```

and for the configuration plane in both scopes, so the whole of contract §2 is a
real round trip:

```env
WEAREDA_API_BASE_URL=http://localhost:4000
WEAREDA_RESELLER_KEY=rsk_example
WEAREDA_TENANT_ID=tenant_demo
```

```bash
npm run cli -- integration:create --mode receive_and_send
npm run cli -- integration:create --mode query_only   # 409 integration_exists
npm run cli -- integration:attach
npm run cli -- integration:test      # 422 read_calls_disabled
npm run cli -- integration:connect   # the 410, and what replaced it
```

The `/api/v1/mock/*` endpoints are a local aid; they are not in the contract.

---

## Reading the outbound log

```
--------------------------------------------------
OUTGOING WEBHOOK
Direction: Reseller -> WeAreDA

Destination:
POST https://api.weareda.com/api/v1/reseller-webhooks/…

Event:
stock.updated

Event ID:
evt_614d52160a9151eab999ba30c3ab8fb7

Items:
2
(quantities are ABSOLUTE on-hand values, never deltas)

Response:
202 Accepted
Operation ID:
op_ba79f15d-954d-4f95-8a2d-d43de3e3460d
--------------------------------------------------
```

Every delivery is also written to `outbound_events` — inspect it with
`GET /debug/events`. Signatures and secrets are never stored.
