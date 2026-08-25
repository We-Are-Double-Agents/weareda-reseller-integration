# Troubleshooting

Every failure below is one the contract names, or one this sandbox produces.
Read the log block first: its second line always says which direction the
request was going.

---

## Inbound: WeAreDA -> Reseller

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
- **`order.status`**: the `state` is outside the mapping table, or the order
  reference matched nothing. Both leave `integration_status` untouched and park
  the event for a human — WeAreDA does not guess.
- **`product.updated`**: the product's `updated_at` is older than what WeAreDA
  holds, so it was ignored as stale; or the item had no `id`/`name` and was
  skipped.

### The catalog is missing products after a sync

If you are in **pull** mode, a full or reconciliation pull archives any
reseller-owned product you did not return. The usual cause is a short page in
the middle of the catalog: WeAreDA pages until a page returns fewer than `limit`
items, so an early short page truncates the catalog and everything after it
looks absent.

An incremental (`updated_since`) pull never archives.

If you are in **push** mode, nothing is ever archived by omission — you must
send `status: "archived"` explicitly.

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
signed and printed but not sent. Either fill them in from your connect response,
or run `npm run mock:weareda` and point at that.

### Stale state between experiments

```bash
rm -rf var/          # drops orders, cancellations, stock and event history
```

The catalog reseeds from `data/products.json` on the next start.

### `/debug/*` returns 404

`ENABLE_DEBUG_ENDPOINTS=false`. Set it to `true` and restart.
