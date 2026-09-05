# Testing

```bash
npm test            # 199 tests, 11 files
npm run test:watch
npm run typecheck
npm run lint
npm run build
```

Vitest, no mocking framework. Inbound tests use Fastify's `inject()`; outbound
tests stand up a real local receiver and verify the signature over the raw body
exactly as WeAreDA does. Each test file gets its own temporary SQLite file, so
files run in parallel without sharing state.

## The suite

| File | Covers |
|---|---|
| `tests/auth.test.ts` | Valid / missing / invalid credentials; all four contract mechanisms (`api_key`, `bearer`, `basic`, `custom`); every contract endpoint is protected; the 401 body leaks nothing. |
| `tests/products.test.ts` | Response shape, CDN image URLs and the assets behind them, variants with attributes, `stock: 0` as a real value, an archived product, pagination (including the short last page that stops WeAreDA, and no repeats across pages), `updated_since` filtering and inclusivity, `updated_at` moving when stock moves. |
| `tests/orders.test.ts` | Creation, `201` then `200`, sequential ids from `SO-10001`, payload stored verbatim, idempotency by header and by body key, different keys are different orders, a changed body under the same key still returns the first order, validation failures create nothing. |
| `tests/cancellation.test.ts` | Per-order path, repeat cancellation, `already_cancelled`, the fallback endpoint matching by `order_number` / `idempotency_key` / `external_order_id`, the `order:` ↔ `order-cancel:` suffix match, `404` for unknown orders and its replay. |
| **`tests/stock-independence.test.ts`** | **Mandatory.** `POST /orders` does not change stock; neither cancel path does; a full lifecycle leaves stock identical; `GET /products` reports the same before and after; absolute (non-delta) `setStock`; and a structural check that the order files contain no reference to the stock API at all. |
| `tests/hmac.test.ts` | A known HMAC vector, `sha256=` hex format, sensitivity to body and secret, verification, the re-serialization trap (`1.0` → `1`), event id format and uniqueness, RFC3339 timestamps, one-event-type-per-request enforcement, builder validation. |
| `tests/webhook-client.test.ts` | Delivery against a real receiver, sent bytes == signed bytes, the three headers, timestamp inside the replay window, `401` on a corrupt signature, `200 {deduped:true}` on a repeated event id, `5xx` retried with the same id and body, `4xx` not retried, batched stock lines, the 500-item and 512 KB caps, dry run, network failure. |
| `tests/event-history.test.ts` | Inbound and outbound history rows, no credentials or signatures stored, the three debug endpoints, disabling them, the PDF fixture and path-traversal refusal. |
| `tests/read-api.test.ts` | The `X-Reseller-Key` plane: correct header, explicitly *not* the HMAC or connector key, no `X-Tenant-Id`, cursor pass-through, all four read endpoints, `401 invalid_reseller_key`, path encoding, a clear error when configuration is missing — and the configuration plane on the same key, in both scopes: `POST /integrations` carrying nothing per-tenant, `attach` carrying nothing reseller-wide and returning that customer's `webhookUrl`, `GET`/`PATCH` with `affectedTenants`/`schedulesReconciled`, the two rotation `PUT`s, `disconnect`, `integration/status` echoing the mode, `422 read_calls_disabled` from `test-connection`, and the removed `connect` refused locally. |
| `tests/integration-mode.test.ts` | The four modes and their two axes; `ordersWrite` switched off without delivery; `productsRead` staying on without reads; capabilities as connector ∩ ceiling ∩ mode, never the declaration; back-compat from `products.mode: "push"`; the **two scopes** — a field of the other scope refused in both directions, `credentialScope` deciding where the credential may travel, `409 integration_exists` on a second create, `404 integration_not_found` on an early attach; every documented `400` (bad mode, string `"true"`, the cross-field rule, nesting in `declaredCapabilities` / `syncConfig`, contradictory `products.mode`, missing `baseUrl`, and the §7 value table down to `documentHosts` refusing an IP literal); the §7.1 merge (named sections replaced whole, `null` deleting, the merged result re-validated) and `409 order_status_write_conflict`; unknown top-level keys dropped while unknown `syncConfig` keys are rejected; re-attaching leaving stored values alone — and, for each of the four modes, that the sandbox really registers only the routes that mode receives. |
| `tests/order-status-write.test.ts` | Both mapping columns including the five `returned` aliases; `shipped`/`delivered` collapsing in one column but not the other; `fulfilled → shipped`; the ladder advancing and discarding late rungs; the two exceptions applying from anywhere; `order_status_conflict`; the opt-in off leaving `orders.status` frozen; every `result.detail` string and `last_error_code`; and `shipped_at`/`delivered_at` filled only when blank. |

## The HMAC test vector

`tests/hmac.test.ts` pins a signature you can reproduce with nothing but
openssl:

```bash
printf '%s' '{"type":"stock.updated"}' | openssl dgst -sha256 -hmac "whsec_example"
```

If your own implementation produces that hex for that body and secret, your
signing is right.

## Testing against the sandbox by hand

```bash
npm run dev

curl -H "X-API-Key: demo_secret" http://localhost:3000/
curl -H "X-API-Key: demo_secret" "http://localhost:3000/products?page=1&limit=3"

curl -X POST http://localhost:3000/orders \
  -H "X-API-Key: demo_secret" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order:6b1e" \
  -d '{"order_number":"ORD-1042","currency":"USD","total":10500,
       "idempotency_key":"order:6b1e",
       "items":[{"external_product_id":"P-1002","external_variant_id":"V-2001",
                 "sku":"WIDGET-PRO-S","quantity":2,"unit_price":5000}]}'

# run it again: same id, no second order
# then confirm stock did not move:
curl http://localhost:3000/debug/products
```

## Testing the outbound direction

```bash
npm run mock:weareda     # a stand-in WeAreDA receiver on :4000
```

```env
WEAREDA_WEBHOOK_URL=http://localhost:4000/api/v1/reseller-webhooks/demo-connection
WEAREDA_WEBHOOK_SECRET=whsec_example
```

```bash
npm run cli -- stock P-1001 37 V-2001 5
npm run cli -- stock P-1001 37 --event-id evt_x    # then repeat it: 200 deduped
```

The mock also serves the configuration plane in both scopes and applies the
`order.status` ladder, so the whole of contract §2 is testable locally:

```env
WEAREDA_API_BASE_URL=http://localhost:4000
WEAREDA_RESELLER_KEY=rsk_example
WEAREDA_TENANT_ID=tenant_demo
```

```bash
npm run cli -- integration:create --mode query_and_send
npm run cli -- integration:attach --order-status-write
npm run cli -- integration:list
npm run cli -- integration:status
npm run cli -- integration:test

curl -X POST http://localhost:4000/api/v1/mock/orders \
  -H 'content-type: application/json' \
  -d '{"external_order_id":"SO-10001","status":"confirmed"}'
npm run cli -- order-status SO-10001 shipped
curl http://localhost:4000/api/v1/mock/operations    # result.detail per operation
```

## Testing a mode

```bash
INTEGRATION_MODE=receive_only npm run dev
curl -i -H "X-API-Key: demo_secret" http://localhost:3000/products   # 404, on purpose
```

```bash
npm run scenario:integration-modes   # all four modes, started and called
npm run scenario:order-status        # the ladder, the exceptions, the conflict
```

## Postman / newman

The collection can be run headlessly:

```bash
npx newman run "postman/WeAreDA Reseller Reference.postman_collection.json" \
  -e "postman/WeAreDA Reseller Reference.postman_environment.json" \
  --folder "01 - Connection Test" --folder "02 - Products" \
  --folder "03 - Orders" --folder "04 - Order Cancellation"
```

Add the webhook folders once `wearedaWebhookUrl` and `webhookSecret` point
somewhere real (WeAreDA, or the mock receiver):

```bash
npx newman run "postman/WeAreDA Reseller Reference.postman_collection.json" \
  -e "postman/WeAreDA Reseller Reference.postman_environment.json" \
  --env-var "wearedaWebhookUrl=http://localhost:4000/api/v1/reseller-webhooks/demo-connection" \
  --env-var "webhookSecret=whsec_example" \
  --folder "05 - WeAreDA Webhooks" --folder "06 - Product Push" \
  --folder "07 - Stock Updates" --folder "08 - Invoices" \
  --folder "10 - Error / Idempotency Scenarios"
```

Folder 09 (the read API) needs real WeAreDA credentials: `wearedaApiBaseUrl`,
`resellerKey` and `tenantId`.

## Testing against real WeAreDA

1. `npm run dev`, then `npm run tunnel`.
2. Set `PUBLIC_BASE_URL` to the tunnel URL and restart.
3. Register the integration with the tunnel URL as `baseUrl` (see the README).
4. Watch the `WeAreDA -> Reseller` block for the `GET /` connection test.
5. Put the returned `webhookUrl` and your `webhookSecret` in `.env`.
6. Place a test order in WeAreDA that reaches the trigger status, and watch
   `POST /orders` arrive.
7. Reply with `npm run cli -- order-status <id> shipped`. If the tenant has
   `orderStatusWrite` on, check that the customer-facing status moved too — and
   that a second, lower transition afterwards does **not** move it back.
8. Check `GET /debug/events` for the full record of both directions.
