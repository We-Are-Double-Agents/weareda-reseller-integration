# Troubleshooting

Every failure below is one the contract names, or one this sandbox produces.
Read the log block first: its second line always says which direction the
request was going.

---

## Configuration time: registering the integration

Configuration has **two scopes** (contract §2) and two calls:
`POST /api/v1/resellers/me/integrations` once, then
`POST .../tenants/{tenantId}/integration/attach` per customer. Most failures
below are one of them being handed a field belonging to the other.

### `410 endpoint_removed` from `POST .../integration/connect`

That endpoint is gone. It took both scopes in one body against a tenant-scoped
URL and upserted the shared half, so connecting one customer rewrote every other
customer's `baseUrl`, auth type, credential scope, capabilities and `syncConfig`
— and rotated the shared credential as a side effect.

Replace one `connect` with:

```bash
npm run cli -- integration:create --mode query_and_send   # once
npm run cli -- integration:attach --order-status-write    # per customer
```

The response names the same two paths, and so does
`npm run cli -- integration:connect`, which no longer calls anything.

### `400 invalid_request` — a field of the wrong scope

The message always names the call the field belongs to.

| Message names | Cause | Fix |
|---|---|---|
| `<field> is an INTEGRATION setting, shared by every tenant of yours` | you put `baseUrl`, `integrationMode`, `credentialScope`, `syncConfig` or `declaredCapabilities` in an **attach** body | send it to `POST /integrations` (or `PATCH /integrations/{provider}`); attaching a customer must never reconfigure the others |
| `<field> is a TENANT setting` | you put `orderStatusWrite`, `orderDeliveryStatus` or `externalTenantId` in the **integration** body | send it to `.../integration/attach` |
| `externalCredentials does not belong here at credentialScope "tenant"` | you sent a credential when creating a tenant-scoped integration | there is no customer yet to own it — send it with each attach |
| `externalCredentials is required at credentialScope "reseller"` | the reseller-wide credential is missing | send it in the create body |
| `externalCredentials belongs here only at credentialScope "tenant"` | you sent a credential while attaching a reseller-scoped integration | rotate the shared one with `PUT /integrations/{provider}/credentials` |
| `<field> is not patchable … use PUT` | you tried to rotate a credential or the webhook secret inside a `PATCH` | rotation is never a side effect: use its own `PUT` |

### `400 invalid_request` — a value that is wrong

| Message names | Cause | Fix |
|---|---|---|
| `orderStatusWrite must be a boolean` | you sent the **string** `"true"` | send a real boolean |
| `orderStatusWrite requires an integrationMode that delivers orders` | you combined it with `query_only` / `receive_only` | pick `query_and_send` or `receive_and_send`, or drop the flag |
| `integrationMode must be one of…` | a typo, or a mode that does not exist | `query_and_send` · `receive_and_send` · `query_only` · `receive_only` |
| `declaredCapabilities.<key> is not a capability` | you nested `integrationMode` / `orderStatusWrite` in there, or invented a capability | move each to the body its scope belongs to; the six keys are `productsRead`, `productsWrite`, `stockRead`, `stockWebhooks`, `ordersWrite`, `invoices` |
| `baseUrl is required` | you left it out of a `receive_only` integration | `receive_only` still registers a `baseUrl`; it is registered, not called |

### `409 integration_exists`

You already have an integration for that provider. `POST /integrations` is a
**create, not an upsert**, precisely so it can never overwrite what your other
customers are running on. Change it with
`PATCH /api/v1/resellers/me/integrations/{provider}`.

### `409 order_status_write_conflict`

You asked for a mode that delivers no orders, while customers are opted into
`orderStatusWrite` — the message names them. They would have no order to report
a status on. Turn the flag off on those tenants
(`PATCH .../tenants/{tenantId}/integration` with `"orderStatusWrite": false`),
then change the mode.

### `404 integration_not_found` when attaching

You are attaching a customer to a provider you have not created yet. Run
`integration:create` first; `integration:list` shows what exists.

### `400 invalid_sync_config`

`syncConfig` is a strict whitelist (contract §7), so a typo there fails loudly.
It is validated the same way on a create and on the **merged** result of a
`PATCH`, so a patch can never store something a create would have refused.

- `syncConfig.integrationMode` — a top-level field of the **integration** body.
- `syncConfig.orderStatusWrite` — a field of the **attach** body.
- `syncConfig.products.mode` contradicting the mode — the transport is derived
  from `integrationMode`, and a contradiction is a `400`, not a precedence rule.
  Remove `products.mode` and let the mode decide. In a `PATCH` it is not
  settable at all.
- a value outside the §7 table: an absolute `*.path`, a `pageSize` over 500, an
  `idempotencyHeader` that is not a header name, or a `documentHosts` entry that
  is a URL, carries a port or path, or is an **IP literal**.

### My `PATCH` wiped half of a syncConfig section

That is contract §7.1, working as specified: a named top-level key is
**replaced whole**, not deep-merged, and `null` deletes it. Read the current
value back first and send it with your change applied:

```bash
npm run cli -- integration:get
npm run cli -- integration:patch --sync-config '{"products":{"path":"/v2","pageSize":200}}'
```

### The setting I sent had no effect and no error

Unknown keys at the **top level of a body** are dropped in **silence**.
`productsSyncMode` is the usual victim: it is a *response* field, never an input,
and sending it does exactly nothing. (Unknown keys inside `syncConfig` are the
opposite — rejected loudly, and so is a field of the wrong scope.)

`npm run cli -- integration:create` and `integration:attach` print a warning
naming every top-level key WeAreDA would drop, before they send.

### `422 { "reason": "read_calls_disabled" }` from test-connection

Your `integrationMode` is `receive_and_send` or `receive_only`, which make no
read calls. **The connection test is itself a read**, so there is nothing for it
to test — it is refused rather than run against an endpoint nobody calls.

That is not a misconfiguration. If you *want* the test, you want a `query_*`
mode.

### Re-attaching a customer changed a setting I did not send

It should not have — attaching is idempotent per customer, and an omitted field
keeps its stored value, as does an omitted field in a `PATCH`. If the mode looks
wrong on a pre-`integrationMode` integration, note the back-compat rule: a stored
`syncConfig.products.mode = "push"` reads as `receive_and_send`.

Note also which call could have changed it. Nothing sent while attaching one
customer can reach reseller-wide settings any more — that was the whole reason
`connect` was retired.

---

## Inbound: WeAreDA -> Reseller

### `404` from your own server for `GET /`, `GET /products` or `POST /orders`

Not a routing bug — check `INTEGRATION_MODE`. This sandbox registers **only** the
routes its mode receives:

| `INTEGRATION_MODE` | `GET /`, `GET /products` | `POST /orders`, cancel |
|---|---|---|
| `query_and_send` (default) | registered | registered |
| `receive_and_send` | **404** | registered |
| `query_only` | registered | **404** |
| `receive_only` | **404** | **404** |

The startup banner lists exactly what exists. `/healthz`, `/fixtures/*` and
`/debug/*` are local helpers and are present in every mode, as are all four
outbound webhook types.

### `401` from your reseller server

WeAreDA's registered credential does not match your `RESELLER_API_KEY`.

Check, in order:

1. `RESELLER_AUTH_MODE` matches the `authType` you registered
   (`api_key` -> `X-API-Key`, `bearer` -> `Authorization: Bearer …`, …).
2. The value itself. `.env` changes need a restart unless you are on
   `npm run dev`.
3. Whitespace or quotes in `.env`. `RESELLER_API_KEY="demo_secret"` includes the
   quotes.

```bash
curl -i -H "X-API-Key: demo_secret" http://localhost:3000/
```

Remember `401`/`403` are **not retried**: the operation goes straight to
`manual_review`. Never return `401` for a transient problem — return `5xx`, which
*is* retried.

### WeAreDA cannot reach you at all / connection test times out

First: are you in a mode that reads at all? In `receive_and_send` /
`receive_only` nothing calls you, and `test-connection` answers
`422 read_calls_disabled` rather than timing out. Then:

- Is the tunnel running? A quick tunnel URL changes every time `cloudflared`
  restarts, so a URL you registered yesterday is probably dead.
- Did you register the tunnel URL (https) rather than `http://localhost:3000`?
- Is the server actually up? `curl http://localhost:3000/healthz`.
- WeAreDA only calls your registered **https** host, re-validates redirects each
  hop, and refuses private/internal addresses (SSRF hardening). A tunnel to a
  public hostname is exactly what it wants.

### WeAreDA accepted the order but `external_order_id` is missing

Your `POST /orders` response did not include a recognized order ID field.

Return the id in `id`, `order_id` or `external_order_id` (or the field you set
via `sync_config.orders.orderIdField`):

```json
{ "id": "SO-10001", "status": "received" }
```

Any `2xx` marks the order `accepted`, so this fails quietly. The consequences
show up later: `order.status` events can then only be matched by `order_number`,
and the per-order cancel path degrades to the fallback endpoint.

Note a `409` carries no id either, which is why this reference answers a
duplicate delivery with `200` and the existing order instead.

### Duplicate orders appearing in your system

You are not deduplicating on the idempotency key. It arrives both as the
`Idempotency-Key` header and as `idempotency_key` in the body, and it is stable
per entity (`order:<orderId>`). WeAreDA retries `5xx`/timeouts, so a request you
already processed but answered too slowly *will* come back.

Check `GET /debug/orders` — this sandbox logs each duplicate explicitly:

```
[ORDER]
Duplicate delivery detected.
Idempotency-Key: order:6b1e
Existing order: SO-10001
No duplicate order created.
```

### A cancellation arrives for an order you don't have

Return `404`. WeAreDA treats `404` (you don't have it) and `409` (already
cancelled) as **idempotent success**. Don't return `500` — that gets retried
forever and then dead-lettered.

### `POST /orders` returns `400` and the order is stuck in `manual_review`

A non-auth `4xx` is not retried. Look at the `details` array in the response and
the log block's `Notes:` line. Then consider whether your validation is too
strict: it is usually better to accept an order with an odd field and sort it
out internally than to reject it into a human queue.

---

## Outbound: Reseller -> WeAreDA

### `401 unauthorized` from the WeAreDA webhook

Either the secret is wrong, or the signature does not cover the bytes you sent.

The second is far more common. It happens when the body is re-serialized after
signing:

```js
const body = JSON.stringify(event);
const sig  = hmac(body, secret);
await fetch(url, { body: JSON.stringify(event) });  // WRONG - different bytes
```

Same data, different bytes (key order, spacing, `1.0` vs `1`), invalid
signature. Sign the string you send, and send the string you signed.

Also check:

- The header is `X-WeAreDA-Signature: sha256=<hex>` — including the `sha256=`
  prefix, lowercase hex.
- You registered a `webhookSecret` at all. A connection without one rejects every
  webhook with `401`.
- No proxy or middleware is reformatting your JSON in flight.

Reproduce a known-good signature:

```bash
printf '%s' '{"type":"stock.updated"}' | openssl dgst -sha256 -hmac "whsec_example"
```

### `401 stale_timestamp`

`X-WeAreDA-Timestamp` is outside the ±5 minute replay window. Your machine's
clock is wrong (very common in VMs and containers that have been suspended), or
the request sat in a queue for minutes before being sent.

Fix the clock — do not widen the window by back-dating the header. The header is
optional, but omitting it is not a fix for a broken clock either, since your
other timestamps will be wrong too.

### `200 { "deduped": true }`

The same `X-WeAreDA-Event-Id` was already processed. Not an error — the event was
a no-op.

If you see it when you did *not* intend a retry, you are reusing an event id
across genuinely different events. Every transition needs its own id:

```bash
npm run cli -- order-status SO-10001 accepted    # its own event id
npm run cli -- order-status SO-10001 shipped     # a different one
```

Dedup is scoped to connection + event type + event id.

**The version of this that looks like nothing happening at all:** if you send no
`X-WeAreDA-Event-Id` *and* no `id` in the body, WeAreDA derives the id from a
**content hash of the raw body**. Two identical payloads therefore have the same
id, and the second dedups silently — `200 {"deduped": true}`, nothing applied,
no error anywhere. Give every event its own id; every sender in this repository
mints a fresh one per send.

### `400 multiple_event_types`

You sent `order.status` and `stock.updated` (or any two types) in one request,
or you wrapped events in a `{ "events": [...] }` envelope. Neither exists in
this contract.

Send N requests, one per event. Note the payload is refused **whole** — WeAreDA
never applies one half.

Batching *within* one type is fine and expected: many items in one
`stock.updated`, many products in one `product.updated`.

### `400 unsupported_event`

The top-level `type` is missing or unknown. It must be top-level — an
`{ "event": { "type": … } }` wrapper is not the contract.

Valid: `order.status`, `stock.updated`, `product.updated`, `invoice.issued`.

### `400 too_many_items`

A `product.updated` batch above 500 products, or a body over 512 KB. It is
refused rather than truncated. Page it as you would page `GET /products` — the
CLI does this automatically:

```bash
npm run cli -- product-update --all --page-size 200
```

### `404 not_found` from the webhook

Unknown or disconnected connection, or the integration is disabled. Check the
`connectionId` in your `WEAREDA_WEBHOOK_URL`, and whether the integration is
still connected on WeAreDA's side.

### `202` but nothing changed

`202` means **queued**, not applied. Effects land shortly after via WeAreDA's
internal queue. Wait, then check.

If it never applies, the usual causes are:

- **`stock.updated`**: the line resolved to nothing. Lines are matched by
  `external_variant_id`, then `external_product_id`, then `sku` — and only
  against products already mapped to your connection. An unmapped id or an
  ambiguous sku is skipped and counted, and the rest of the event still applies.
  Make sure the ids are the ones you sent in `/products`.
- **`order.status`**: the `state` is outside the mapping table
  (`unknown_order_state`), or the order reference matched nothing
  (`order_not_found`). Both leave `integration_status` untouched and park the
  event for a human — WeAreDA does not guess.
- **`product.updated`**: the product's `updated_at` is older than what WeAreDA
  holds, so it was ignored as stale; or the item had no `id`/`name` and was
  skipped.

### `order.status` applied, but the customer-facing status did not move

That is the default. Without `orderStatusWrite: true` an `order.status` moves
only `integration_status`; the column the tenant's staff see stays frozen. The
operation says so in `result.detail`:

| `result.detail` | what to do |
|---|---|
| `completed; status unchanged (status_write_disabled)` | the opt-in is off — re-attach that customer, or `PATCH .../tenants/{tenantId}/integration`, with `"orderStatusWrite": true` |
| `completed; status unchanged (unmapped_state)` | you sent `rejected` / `failed` / `error`; those report an integration failure, not a business state |
| `completed; status unchanged (already_current)` | the order was already there. Harmless |
| `completed; status unchanged (backward)` | the ladder only advances, and this rung is below where the order sits — a late or reordered event |

The ladder is `draft → pending → confirmed → processing → shipped → delivered`.
If you are replaying history, replay it **in order**; anything below the current
rung is discarded, deliberately.

### `order_status_conflict`

You reported a fulfilment step for an order WeAreDA already holds as `cancelled`
or `refunded`. That is a contradiction between the two systems, not an update:
the order is left untouched, its `integration_status` becomes `manual_review`,
and the operation is rejected. Neither side wins automatically — someone has to
decide which system is right.

The reverse direction is fine: `cancelled` and `refunded` apply from any rung at
any time, including after `shipped` or `delivered`.

### `unknown_order_state` for a state I thought was valid

Check the spelling against the aliases, which are wider than people expect:

```
accepted | acknowledged | ack
shipped  | fulfilled
delivered | completed
cancelled | canceled
returned | return | refunded | not_delivered | undelivered
rejected | failed | error
```

Anything else — `packed_in_warehouse`, `in_transit`, `confirmed` — is not mapped.
WeAreDA does not guess, and the order is left exactly as it was.

Note `fulfilled` maps to `shipped`, not `delivered`. That is deliberate: the
ladder would discard a later `delivered` if the top rung had already been
guessed.

### The catalog is missing products after a sync

If you are in **pull** mode, a full or reconciliation pull archives any
reseller-owned product you did not return. The usual cause is a short page in
the middle of the catalog: WeAreDA pages until a page returns fewer than `limit`
items, so an early short page truncates the catalog and everything after it
looks absent.

An incremental (`updated_since`) pull never archives.

If you are in **push** mode, nothing is ever archived by omission — you must
send `status: "archived"` explicitly.

### Products sync but their images do not

WeAreDA fetches image URLs from your catalog, so the URL has to be reachable
from the public internet, over HTTPS, without credentials. Check what your
catalog actually advertises:

```bash
curl -H "X-API-Key: demo_secret" http://localhost:3000/products | grep -o 'https://[^"]*png' | sort -u
```

Then fetch one of those URLs yourself, from outside your network. If that fails,
WeAreDA's fetch fails too.

The bundled catalog points at `https://cdn.weareda.com/demo/products/`. The same
images ship in `fixtures/products/`, so if the CDN is unavailable to you, point
the catalog at a relative path instead (`/fixtures/products/toolkit.png`), run
`npm run tunnel` and set `PUBLIC_BASE_URL` — the sandbox then serves the images
over your tunnel.

An image URL that is relative, plain `http`, or on `localhost` is never
retrievable by WeAreDA.

### A `product.updated` push did not archive the products I left out

Correct behaviour. A push says "here is what changed", never "here is everything
I have". Retire a product by sending it with `"status": "archived"`.

---

## The one that is not a bug

### Order completed but stock did not change

**This is correct.** Order status and inventory are independent flows.

WeAreDA never decrements, reserves, increments or restores your stock because an
order was created, accepted, fulfilled, shipped, delivered or cancelled. It
changes only the order's `integration_status`.

If that order changed your inventory, your ERP recalculates it and you publish
the result:

```bash
npm run cli -- stock P-1001 37        # 37 is the new ABSOLUTE on-hand
```

The same applies in reverse: cancelling an order restores nothing. If units
return to inventory, send a `stock.updated` with the new absolute quantities.

```bash
npm run scenario:order
npm run scenario:cancellation
```

both narrate this, and this sandbox has
[tests](../tests/stock-independence.test.ts) that fail if an order ever moves
stock.

---

## Sandbox-specific problems

### `npm run dev` fails with `node:sqlite` not found

You need **Node 22.5 or newer**. `node --version`.

### `cloudflared is not installed`

`npm run tunnel` prints install instructions for macOS, Linux and Windows, and
the `ngrok http 3000` alternative. A Cloudflare quick tunnel needs no account.

### The tunnel URL changed and WeAreDA now gets errors

Quick tunnel URLs are ephemeral. Re-register the new `baseUrl`, and update
`PUBLIC_BASE_URL` so invoice `document_url`s point at the live host.

### `document_url` warnings from the invoice command

```
WARNING: that URL is not HTTPS, so WeAreDA cannot fetch it.
```

`PUBLIC_BASE_URL` is unset, so the URL falls back to `http://localhost:3000`,
which WeAreDA cannot reach. Set it to your tunnel URL. The invoice would still
be recorded, with `document_status: "failed"`.

### Everything says DRY RUN

`WEAREDA_WEBHOOK_URL` and/or `WEAREDA_WEBHOOK_SECRET` are unset, so events are
signed and printed but not sent. Either fill them in from your attach response,
or run `npm run mock:weareda` and point at that.

### Stale state between experiments

```bash
rm -rf var/          # drops orders, cancellations, stock and event history
```

The catalog reseeds from `data/products.json` on the next start.

### `/debug/*` returns 404

`ENABLE_DEBUG_ENDPOINTS=false`. Set it to `true` and restart.
