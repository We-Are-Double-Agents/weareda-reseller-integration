# WeAreDA Reseller Reference Implementation

A complete, runnable reference implementation **and** local sandbox for the
WeAreDA Reseller Integration API.

This repository simulates the **commerce / ERP side** of a WeAreDA reseller
integration.

```
WeAreDA calls this server to:        This server calls WeAreDA to:
  - read products                      - report order status
  - deliver orders                     - report stock
  - cancel orders                      - push catalog changes
                                       - send invoice information
```

The authoritative specification is
[`RESELLER_INTEGRATION_API_CONTRACT.md`](RESELLER_INTEGRATION_API_CONTRACT.md),
included here in full. Everything in this repository implements that contract;
where the code makes a choice the contract leaves open, a comment says so and
names the section.

> ### The one rule to internalise first
>
> **Orders and stock are two independent flows.**
>
> Receiving an order does not decrement stock. Cancelling an order does not
> restore it. WeAreDA never reserves, decrements, increments or restores your
> inventory because of an order — *you* are the authority on your stock, and you
> report it with a **separate** `stock.updated` event carrying **absolute**
> quantities.
>
> This repository demonstrates that rule everywhere, and
> [enforces it with mandatory tests](tests/stock-independence.test.ts).

---

## Contents

- [Architecture](#architecture)
- [Five-minute quick start](#five-minute-quick-start)
- [Connecting WeAreDA to your sandbox](#connecting-weareda-to-your-sandbox)
- [The four integration modes](#the-four-integration-modes)
- [Reporting order status back](#reporting-order-status-back)
- [The three authentication contexts](#the-three-authentication-contexts)
- [Endpoints this server implements](#endpoints-this-server-implements-weareda---reseller)
- [Events this server sends](#events-this-server-sends-reseller---weareda)
- [CLI](#cli)
- [Guided scenarios](#guided-scenarios)
- [Orders and stock are independent](#orders-and-stock-are-independent)
- [Local inspection](#local-inspection)
- [Postman](#postman)
- [Testing](#testing)
- [Docker](#docker)
- [Project layout](#project-layout)
- [Documentation](#documentation)

---

## Architecture

```
                        WeAreDA
                           |
                           |  HTTPS
                           v
                    Public tunnel                (npm run tunnel)
                    https://xxx.trycloudflare.com
                           |
                           v
        +--------------------------------------------------+
        |   Local Node server               localhost:3000 |
        |                                                  |
        |   GET  / .................. health         reads |
        |   GET  /products .......... catalog + stock      |
        |                                                  |
        |   POST /orders ............ order delivery       |
        |   POST /orders/{id}/cancel                       |
        |   POST /orders/cancel ..... fallback    delivery |
        |                                                  |
        |   SQLite: orders | stock | event history         |
        +--------------------------------------------------+
          INTEGRATION_MODE decides which of those two groups
          exists at all. A receive_only sandbox registers
          neither, and still publishes every webhook below.
                           |
                           |  signed webhook (HMAC-SHA256)
                           v
              WeAreDA Reseller Webhook API
              order.status | stock.updated
              product.updated | invoice.issued
```

Two directions, named the same way everywhere in the code, the logs and the
docs:

| Direction | Who calls whom | What travels |
|---|---|---|
| **WeAreDA -> Reseller** | WeAreDA calls this server | health check, catalog pull, order delivery, cancellation |
| **Reseller -> WeAreDA** | this server calls WeAreDA | `order.status`, `stock.updated`, `product.updated`, `invoice.issued` |

Every log block states its direction on the second line. You should never have
to guess which way a request was going.

---

## Five-minute quick start

Requires **Node 22.5 or newer** (for the built-in `node:sqlite` module).

```bash
git clone <this-repo>
cd weareda-reseller-reference
cp .env.example .env
npm install
npm run dev
```

That is a working reseller system. Try it:

```bash
curl -H "X-API-Key: demo_secret" http://localhost:3000/
curl -H "X-API-Key: demo_secret" "http://localhost:3000/products?page=1&limit=3"
```

Now make it reachable from the internet so WeAreDA can call it:

```bash
npm run tunnel
```

which prints:

```
==================================================
WeAreDA Reseller Sandbox
==================================================

Local URL:
http://localhost:3000

Public URL:
https://example.trycloudflare.com

Use this as your WeAreDA baseUrl:

https://example.trycloudflare.com

Health endpoint:
GET https://example.trycloudflare.com/

Products:
GET https://example.trycloudflare.com/products
==================================================
```

The tunnel is a standalone script, not part of the server — the sandbox works
perfectly well without it. `cloudflared` needs no account for a quick tunnel;
`ngrok http 3000` works too. See [docs/troubleshooting.md](docs/troubleshooting.md)
if the tunnel misbehaves.

### Try the outbound direction without a WeAreDA connection

Every outbound command runs in **dry run** mode when `WEAREDA_WEBHOOK_URL` is
unset: it signs and prints the request instead of sending it.

```bash
npm run cli -- stock P-1001 37 V-2001 5
```

When you want a real round trip before you have a WeAreDA connection, run the
included stand-in receiver:

```bash
npm run mock:weareda          # in another terminal
```

then put its two values in `.env` and the same command actually delivers, and
gets back `202 { accepted: true, operationId }`.

---

## Connecting WeAreDA to your sandbox

1. Start the server and the tunnel. Copy the public HTTPS URL.
2. Set `PUBLIC_BASE_URL` in `.env` to that URL and restart, so `invoice.issued`
   events carry a `document_url` WeAreDA can actually fetch. (Product images
   already point at `https://cdn.weareda.com/demo/products/`, so they need no
   tunnel.)
3. Register the integration for your tenant (contract §2):

   ```jsonc
   POST /api/v1/resellers/me/tenants/{tenantId}/integration/connect
   {
     "provider": "generic_http",
     "baseUrl": "https://example.trycloudflare.com",  // your tunnel URL
     "authType": "api_key",
     "externalCredentials": { "apiKey": "demo_secret" },  // = RESELLER_API_KEY
     "webhookSecret": "whsec_example",
     "orderDeliveryStatus": "confirmed",
     "integrationMode": "query_and_send",  // §1.1 - which calls WeAreDA makes
     "orderStatusWrite": false             // §6.1 - opt-in, strict boolean
   }
   ```

   `integrationMode` and `orderStatusWrite` are **top-level** fields, siblings of
   `orderDeliveryStatus`. Inside `declaredCapabilities` they are
   `400 invalid_request`; inside `syncConfig`, `400 invalid_sync_config`.

   The sandbox can make this call for you, validating the body locally first:

   ```bash
   npm run cli -- integration:connect --mode query_and_send --order-status-write
   npm run cli -- integration:status
   ```

4. The response returns your inbound webhook URL. Put it, and the secret you
   just registered, into `.env`:

   ```env
   WEAREDA_WEBHOOK_URL=https://api.weareda.com/api/v1/reseller-webhooks/<connectionId>
   WEAREDA_WEBHOOK_SECRET=whsec_example
   ```

5. WeAreDA calls `GET /` to verify the credentials. Watch your terminal — the
   request appears as a labelled `WeAreDA -> Reseller` block.

Catalog **pull** is the default. If you would rather push, choose an
`integrationMode` that does not read — `receive_and_send` or `receive_only` — and
use `npm run cli -- product-update --all`; WeAreDA then never calls
`GET /products`, or `GET /` either. `productsSyncMode` is **derived** from the
mode and returned in the response; it is never an input, and a contradictory
`syncConfig.products.mode` is a `400`. This sandbox implements both transports.

---

## The four integration modes

Four calls go from WeAreDA to this server, and they split along **two
independent axes** — does WeAreDA ever **read** from us, and do we ever
**receive an order** (contract §1.1)?

| Call | Axis |
|---|---|
| `GET /` (connection test) | reads |
| `GET /products` (catalog pull) | reads |
| `POST /orders` | order delivery |
| `POST /orders/{id}/cancel` | order delivery |

| `integrationMode` | reads | order delivery | catalog arrives via | you must implement |
|---|---|---|---|---|
| `query_and_send` **(default)** | yes | yes | scheduled pull (pushes also accepted) | all four calls |
| `receive_and_send` | **no** | yes | `product.updated` webhooks only | `POST /orders` + cancel |
| `query_only` | yes | **no** | scheduled pull (pushes also accepted) | `GET /` + `GET /products` |
| `receive_only` | **no** | **no** | `product.updated` webhooks only | nothing — publish only |

The four points people get wrong:

- **Inbound webhooks are not an axis.** All four event types can be published in
  **every** mode, given a webhook secret. The mode governs what WeAreDA does.
- **`receive_and_send` is not "no outbound calls".** Orders are still delivered —
  delivering an order is a *send*, not a query.
- **`receive_only` still requires a `baseUrl`.** It is registered, not called.
- **A `receive_*` mode makes the connection test impossible**, because the test is
  itself a read: `POST …/integration/test-connection` answers `422` with
  `reason: "read_calls_disabled"`.

This sandbox does not merely describe that — it **registers only the routes its
mode receives**:

```bash
INTEGRATION_MODE=receive_only npm run dev

curl -i -H "X-API-Key: demo_secret" http://localhost:3000/           # 404
curl -i -H "X-API-Key: demo_secret" http://localhost:3000/products   # 404
npm run cli -- product-update --all                                  # works
```

A reseller with **no read endpoint at all** is a complete, working integration.

```bash
npm run scenario:integration-modes   # all four, started and called for real
```

Full reference, with a worked connect call and response per mode:
[docs/integration-modes.md](docs/integration-modes.md).

---

## Reporting order status back

An inbound `order.status` moves **two** columns, and the second one is opt-in
(contract §6.1):

| your `state` (aliases) | → `integration_status` | → `orders.status` *(opt-in only)* |
|---|---|---|
| `accepted` / `acknowledged` / `ack` | `accepted` | `confirmed` |
| `shipped` / `fulfilled` | `completed` | `shipped` |
| `delivered` / `completed` | `completed` | `delivered` |
| `cancelled` / `canceled` | `cancelled` | `cancelled` |
| `returned` / `return` / `refunded` / `not_delivered` / `undelivered` | `returned` | `refunded` |
| `rejected` / `failed` / `error` | `manual_review` | *(unchanged)* |
| anything else | not mapped → `unknown_order_state` | *(unchanged)* |

`orderStatusWrite: true` at connect time turns the third column on. It then moves
both in one atomic write and fires the same alerts and lifecycle automation a
manual status change in the CRM fires.

```
LADDER      draft → pending → confirmed → processing → shipped → delivered
            Only ever ADVANCES. A lower rung arriving after a higher one is a
            late or reordered event and is ignored, not applied.

EXCEPTIONS  cancelled, refunded
            Apply from ANY rung at ANY time — including after shipped/delivered.
```

A fulfilment step for an order WeAreDA already holds as `cancelled`/`refunded` is
a **contradiction**, not an update: the order is untouched, its
`integration_status` becomes `manual_review`, and the operation is rejected with
`order_status_conflict`. Neither side wins automatically.

`orderStatusWrite` is per **tenant** and is about data authority;
`integrationMode` is per **reseller** and is about topology. Choosing
`receive_and_send` does **not** imply `orderStatusWrite` — and combining the flag
with `query_only` / `receive_only` is a `400`, since those resellers never receive
an order to report a status on.

```bash
npm run scenario:order-status    # the mapping, the ladder, the conflict
```

Details, the `result.detail` diagnostics and every error code:
[docs/orders.md](docs/orders.md#reporting-progress-back).

---

## The three authentication contexts

Mixing these up is the most common integration mistake, so they are kept
visibly separate throughout the repository.

| # | Direction | Credential | Header |
|---|---|---|---|
| 1 | **WeAreDA -> Reseller** | `RESELLER_API_KEY` | `X-API-Key: <key>` (or bearer / basic / custom) |
| 2 | **Reseller -> WeAreDA** webhook | `WEAREDA_WEBHOOK_SECRET` | `X-WeAreDA-Signature: sha256=<hmac of the raw body>` |
| 3 | **Reseller -> WeAreDA** management API | `WEAREDA_RESELLER_KEY` | `X-Reseller-Key: <key>` |

They are three different secrets doing three different jobs:

- **(1)** proves to *you* that the caller is WeAreDA.
- **(2)** proves to *WeAreDA* that the webhook came from you. It is an HMAC over
  the exact bytes of the body — not a bearer token.
- **(3)** is a plain key for the read/management API on WeAreDA's backend
  (contract §11), which is a different plane entirely from (1) and (2).

Full detail in [docs/authentication.md](docs/authentication.md).

---

## Endpoints this server implements (WeAreDA -> Reseller)

| Method | Path | Contract | Registered in | Purpose |
|---|---|---|---|---|
| `GET` | `/` | §4.1 | modes that **read** | Connection test. Any 2xx passes. |
| `GET` | `/products` | §4.2 | modes that **read** | Catalog + stock pull. `page`, `limit`, `updated_since`. |
| `POST` | `/orders` | §4.3 | modes that **deliver** | Order delivery. Idempotent. Always returns the order id. |
| `POST` | `/orders/{externalOrderId}/cancel` | §4.4 | modes that **deliver** | Cancellation by the id you returned. |
| `POST` | `/orders/cancel` | §4.4 | modes that **deliver** | Fallback: match by `order_number` or `idempotency_key`. |

A route its `integrationMode` never receives is **not registered at all** — the
sandbox answers `404`, exactly as a reseller that never implemented it would. The
startup banner lists what exists.

Local helpers that are **not** part of the contract:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Unauthenticated liveness probe (Docker, load balancers). |
| `GET` | `/fixtures/invoices/demo.pdf` | The demo invoice PDF, so `document_url` is fetchable. |
| `GET` | `/fixtures/products/*.png` | The sample product images, also hosted at `cdn.weareda.com/demo/products/`. |
| `GET` | `/debug/orders`, `/debug/products`, `/debug/events` | JSON inspection. |

---

## Events this server sends (Reseller -> WeAreDA)

One HTTP request carries **exactly one** event type (contract §6.0).
`order.status` and `stock.updated` are always two separate requests.

| Event | Container | Batching |
|---|---|---|
| `order.status` | `order` | one event per transition |
| `stock.updated` | `items` | **batch every affected product and variant into one event** |
| `product.updated` | `products` | batch up to 500 products / 512 KB per event |
| `invoice.issued` | `invoice` | one invoice per event |

The client that sends them ([`src/weareda/webhook-client.ts`](src/weareda/webhook-client.ts))
serializes the body **once**, signs that exact string, and sends that same
string — never a re-serialization. See [docs/webhooks.md](docs/webhooks.md).

---

## CLI

```bash
npm run cli -- <command> [args] [--dry-run] [--event-id evt_...]
```

| Command | Event | Example |
|---|---|---|
| `stock <id> <qty> [...]` | `stock.updated` | `npm run cli -- stock P-1001 37 V-2001 5` |
| `order-status <orderId> <state>` | `order.status` | `npm run cli -- order-status SO-10001 shipped` |
| `product-update <ids...> \| --all` | `product.updated` | `npm run cli -- product-update --all` |
| `invoice <orderId>` | `invoice.issued` | `npm run cli -- invoice SO-10001` |
| `integration:connect [--mode M] [--order-status-write]` | — | connect API (contract §1.1/§2) |
| `integration:status` | — | echoes mode, delivery, sync mode |
| `integration:test` | — | `422 read_calls_disabled` in a `receive_*` mode |
| `orders:list` | — | read API (contract §11) |
| `orders:get <orderId>` | — | read API |
| `orders:invoices <orderId>` | — | read API |
| `invoice:document <invoiceId>` | — | read API |

Shortcuts:

```bash
npm run demo:stock          # stock.updated with two batched lines
npm run demo:order-status   # order.status shipped
npm run demo:products       # product.updated with the whole catalog
npm run demo:invoice        # invoice.issued with the demo PDF
npm run demo:connect        # connect, query_and_send + orderStatusWrite
```

Every command prints the destination URL, method, event type, event id,
timestamp, request body, response status and response body. **Credentials are
always masked** — the CLI never prints a secret.

`npm run cli -- stock P-1001 37` does two separate things, in this order:

1. simulates *your ERP* recalculating inventory (the sandbox's own stock
   changes), then
2. reports the new absolute quantity to WeAreDA.

That ordering is the whole point. See below.

---

## Guided scenarios

```bash
npm run scenario:order              # delivery -> ERP recalculation -> stock.updated -> status transitions
npm run scenario:cancellation       # cancellation -> no restock -> explicit restock -> stock.updated
npm run scenario:catalog-push       # pull vs push, and what a push does NOT mean
npm run scenario:integration-modes  # the four modes, each started and called for real
npm run scenario:order-status       # both status columns, the ladder, the conflict
```

Each scenario narrates every step and drives **both** directions: it calls the
sandbox the way WeAreDA would, and sends signed webhooks the way your ERP would.
If a server is already running on `PORT` it is reused, so you can watch the
request log in the other terminal; otherwise the scenario starts one itself.

---

## Orders and stock are independent

This is contract §6.4, and it is the rule integrators most often get wrong.

```
Flow A - order delivery                  Flow B - inventory change
-----------------------                  -------------------------
POST /orders            ---> accepted    your ERP recalculates stock
order.status: shipped   ---> completed   POST stock.updated (absolute)
POST .../cancel         ---> cancelled

           changes the order's                 changes stock
           integration_status                  and nothing else
           and NOTHING else
```

| WeAreDA sees | Order `integration_status` | Reseller-owned stock |
|---|---|---|
| `POST /orders` returns `201` | -> `accepted` | **unchanged** |
| `order.status: fulfilled` | -> `completed` | **unchanged** |
| `order.status: cancelled` | -> `cancelled` | **unchanged** |
| `POST /orders/{id}/cancel` returns `2xx` | -> `cancelled` | **unchanged** |
| `stock.updated` | **unchanged** | -> set to the absolute quantities |

An order will often *cause* stock to change on your side. That recalculation is
yours, and it reaches WeAreDA only as a separate `stock.updated`. Stock also
changes for reasons unrelated to WeAreDA — a supplier delivery, a sale in your
own shop, a stock count — through exactly the same mechanism.

**`quantity` is absolute.** `"quantity": 37` means *there are now 37*. It never
means *add 37*. `0` is a real value meaning sold out.

In this repository the rule is structural, not just documented:
`src/routes/orders.ts` and `src/services/order-service.ts` contain no call into
the stock API at all, and
[`tests/stock-independence.test.ts`](tests/stock-independence.test.ts) fails if
that ever changes.

More in [docs/stock.md](docs/stock.md).

---

## Local inspection

JSON only — there is no admin UI here, by design.

```bash
curl http://localhost:3000/debug/orders    # orders received, with their payloads
curl http://localhost:3000/debug/products  # catalog as served, plus the stock table
curl http://localhost:3000/debug/events    # inbound requests AND outbound webhooks
```

`/debug/events` is the integration diary: event ids, idempotency keys, response
statuses, timings, dry-run flags. Credentials and signatures are never stored.

Gate them with `ENABLE_DEBUG_ENDPOINTS=false` when you don't want them.

State lives in SQLite (`var/sandbox.db` by default), so restarting the sandbox
does not lose the orders you received.

---

## Postman

```
postman/WeAreDA Reseller Reference.postman_collection.json
postman/WeAreDA Reseller Reference.postman_environment.json
```

Import both, then fill in the environment. 57 requests in 11 folders covering
every endpoint, every event type and every documented error.

Folder 00 registers the integration: a connect call per `integrationMode`, the
`orderStatusWrite` opt-in, `integration/status`, `test-connection` (watch it
answer `422 read_calls_disabled` after a `receive_*` connect) and every
connect-time `400` — including the one that is not an error at all, a top-level
`productsSyncMode` dropped in silence. Point `wearedaApiBaseUrl` at
`npm run mock:weareda` to run it without a real connection.

Webhook requests **sign themselves**: a pre-request script builds the event,
serializes it once, signs those exact bytes with `webhookSecret`, and sets
`X-WeAreDA-Signature`, `X-WeAreDA-Event-Id` and `X-WeAreDA-Timestamp`. The body
is the same string that was signed.

Folder 10 lets you see each failure mode once, on purpose: a signature computed
over different bytes, a stale timestamp, two event types in one request, a batch
envelope, an oversized product batch, a replayed event id.

Folder 05 covers both status columns: the `accepted -> shipped -> delivered`
sequence, `returned` (a return is not a cancellation), a `refunded` applying
after delivery, and a fulfilment step after a cancellation — which answers `202`
on the transport and is then rejected on the operation with
`order_status_conflict`.

---

## Testing

```bash
npm test        # 199 tests
npm run lint
npm run build
npm run typecheck
```

Covers authentication (all four mechanisms), pagination and `updated_since`,
order creation and idempotency, cancellation and its fallback, HMAC signing
against a known vector, one-event-type-per-request enforcement, batch caps,
retry/dedup behaviour, the read and connect API's authentication plane, the four
integration modes and every connect-time `400`, the `order.status` mapping,
ladder and conflict rules — and the mandatory stock-independence tests.

[docs/testing.md](docs/testing.md) describes each file.

---

## Docker

Optional. `npm run dev` remains the primary workflow.

```bash
docker compose up --build
```

Same sandbox, port 3000, with SQLite persisted in the `sandbox-data` volume.
Configuration comes from your environment or `.env` (see `docker-compose.yml`).

---

## Project layout

```
src/
  index.ts                 entry point and startup banner
  server.ts                route registration
  config/env.ts            typed configuration, three auth contexts kept apart
  middleware/
    auth.ts                inbound auth: api_key | bearer | basic | custom
    request-logger.ts      the "WeAreDA -> Reseller" log blocks
  routes/
    health.ts              GET /
    products.ts            GET /products
    orders.ts              POST /orders, cancellation
    fixtures.ts            the invoice PDF
    debug.ts               JSON inspection
  services/
    product-service.ts     ONE serializer for pull and push; owns stock
    order-service.ts       orders, idempotency - and no stock, ever
    event-log.ts           local history
  storage/db.ts            SQLite schema (node:sqlite, no native deps)
  weareda/
    types.ts               wire types, state mapping (both columns), the
                           ladder + transition rules, batch caps
    integration-mode.ts    the four modes, capabilities, connect-body validation
    events.ts              builders - one event type by construction
    webhook-client.ts      sign-once-send-those-bytes delivery
    reseller-api-client.ts X-Reseller-Key plane: connect (contract 2) + read API (11)
  cli/                     the reseller -> WeAreDA commands
  scenarios/               guided end-to-end walkthroughs
scripts/
  tunnel.mjs               cloudflared quick tunnel + banner
  mock-weareda.mjs         stand-in WeAreDA: webhooks, the connect plane and
                           the order.status ladder
data/products.json         catalog fixtures
fixtures/invoices/         demo invoice PDF + metadata
fixtures/products/         sample product images (the assets behind the demo CDN URLs)
postman/                   collection + environment
docs/                      developer documentation
tests/                     vitest suite
```

---

## Documentation

| File | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the pieces fit, and why they are shaped this way |
| [docs/authentication.md](docs/authentication.md) | The three credentials, in detail |
| [docs/integration-modes.md](docs/integration-modes.md) | `integrationMode`, `orderStatusWrite`, `declaredCapabilities` — values, defaults, placement, every `400` |
| [docs/products.md](docs/products.md) | Catalog pull, push, pagination, `updated_since` |
| [docs/orders.md](docs/orders.md) | Delivery, idempotency, cancellation, `order.status` and its two status columns |
| [docs/stock.md](docs/stock.md) | Absolute quantities, batching, independence from orders |
| [docs/webhooks.md](docs/webhooks.md) | Signing, event ids, retries, dedup, one type per request |
| [docs/invoices.md](docs/invoices.md) | `invoice.issued` and the document fetch |
| [docs/testing.md](docs/testing.md) | The test suite, and how to test against WeAreDA |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Every error you are likely to hit |

The contract itself stays authoritative: these documents explain and cross-
reference it rather than restating it.

---

## Safety

Everything in this repository is sample data: `demo_secret`, `whsec_example`,
`rsk_example`, `P-1001`, `SO-10001`, `TENANT_ID`, `cdn.example.com`. There are
no real credentials, tenant ids, customers or production URLs. Your `.env` is
gitignored — keep it that way.
