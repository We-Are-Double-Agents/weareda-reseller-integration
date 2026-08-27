# Architecture

The authoritative specification is
[`../RESELLER_INTEGRATION_API_CONTRACT.md`](../RESELLER_INTEGRATION_API_CONTRACT.md).
This document explains how the reference implementation is put together and why.

## What this repository is

It is **the reseller's system** — the commerce / ERP side. It implements the
endpoints WeAreDA calls, and it calls the WeAreDA webhook. It is not a WeAreDA
simulator, and it is not an admin panel.

```
                        WeAreDA
                           |
                           |  HTTPS + credentials you registered
                           v
                    Public tunnel                (optional, npm run tunnel)
                           |
                           v
        +------------------------------------------+
        |   Local Node server                       |
        |                                           |
        |   routes/     health, products, orders    |
        |   services/   products (+stock), orders   |
        |   storage/    SQLite                      |
        +------------------------------------------+
                           |
                           |  HMAC-signed webhook
                           v
              WeAreDA Reseller Webhook API
```

## Direction is a first-class concept

Every request in this integration belongs to exactly one direction, and the code
names it everywhere — in module headers, in log blocks, in the docs:

- **WeAreDA -> Reseller** — inbound. `GET /`, `GET /products`, `POST /orders`,
  the two cancel paths. Which of them exist depends on `integrationMode`.
- **Reseller -> WeAreDA** — outbound. The four webhook event types, plus the
  separate management/read API.

If you are ever unsure which way a request went, the log block's second line
says so.

## Layers

| Layer | Responsibility | Notes |
|---|---|---|
| `routes/` | HTTP shape: status codes, validation errors, headers | Thin. No business rules. |
| `services/` | The actual behaviour: catalog, stock, orders, idempotency | Where the contract rules live. |
| `storage/` | SQLite schema and access | `node:sqlite`, no native dependencies. |
| `weareda/` | Everything about the outbound wire format | Types, event builders, signing, read API, and the connect-time integration model. |
| `cli/`, `scenarios/` | Operator-facing entry points | Thin wrappers over `weareda/` and `services/`. |

The code is deliberately explicit rather than clever. There is no dependency
injection container, no ORM, no plugin system, and no code generation — a
developer porting this to PHP, Python, Java or .NET should be able to read a
file top-to-bottom and translate it.

## Key design decisions

### The integration mode gates route registration, not request handling

`integrationMode` (contract §1.1) says which of the four calls WeAreDA ever makes
to a reseller. `server.ts` reads it and **registers only those routes** — a
`receive_only` sandbox has no `GET /` and no `POST /orders` at all, and answers
`404` from the not-found handler.

The alternative — registering everything and returning `403 mode_disabled` — was
rejected because it teaches the wrong thing. The point of `receive_and_send` is
that a reseller can integrate with **no read endpoint whatsoever**; a sandbox
that keeps answering `GET /products` cannot demonstrate that. The mode is a
property of the deployment, so it is applied at wiring time, once, rather than
re-checked on every request.

The two derived predicates live next to the config that produces them
(`readCallsEnabled`, `orderDeliveryEnabled` in `config/env.ts`), so no route file
has to know the mode table.

### The connect body is modelled, and validated locally

`weareda/integration-mode.ts` is the reseller's model of WeAreDA-side rules: the
mode table, the capability intersection, and `validateConnectBody()`, which
applies every documented `400` — including the placement traps — **before** the
request leaves the process. The CLI prints the exact error WeAreDA would return.

That is worth the duplication because the failure it prevents is the silent one:
unknown keys at the top level of the connect body are dropped without a word, so
a misplaced `integrationMode` looks exactly like a feature that does not work.

### The order.status decision is one pure function

`resolveOrderStatusTransition()` in `weareda/types.ts` takes the current
customer-facing status, the raw reseller `state` and the tenant's
`orderStatusWrite` flag, and returns both columns, the `result.detail` string and
the `last_error_code`. The ladder, the two exceptions and the conflict rule are
all in that one function, so the CLI's prediction, the scenario's narration and
the test suite's assertions cannot disagree with each other.

It is pure and stateless on purpose: the rules are the interesting part, and they
are readable without a database.

### One serializer for the catalog

`ProductService.serialize()` produces the product object used by **both**
`GET /products` (pull) and `product.updated` (push). The contract says these are
the same objects (§6.5), so the implementation makes it structurally true —
they cannot drift apart.

### Stock lives with products, never with orders

`ProductService` owns stock. `OrderService` has no access to it, and neither do
the order routes. That is not an accident of layering; it is how contract §6.4
is enforced structurally rather than by convention. A test asserts that these
files contain no reference to the stock API.

The only way stock changes in this sandbox is an explicit ERP simulation:
`npm run cli -- stock P-1001 37`.

### Event builders make invalid events unrepresentable

Contract §6.0 allows exactly one event type per request. Rather than validate
that after the fact, `weareda/events.ts` exposes four builders, each producing
exactly one type with exactly its own payload container. `assertSingleEventType`
then runs as a second, defensive check before anything is sent — and produces
the same error names WeAreDA would return (`multiple_event_types`,
`unsupported_event`).

### Serialize once, sign those bytes, send those bytes

`webhook-client.ts` calls `JSON.stringify` exactly once per event. The resulting
string is signed and passed straight to `fetch`. There is no path through the
module where the body is re-serialized after signing — the single most common
cause of `401 unauthorized` on a webhook.

### SQLite via `node:sqlite`

State survives a restart, which matters when you are testing a real integration
over a tunnel and don't want to lose the orders WeAreDA already delivered. The
built-in module means `npm install` never compiles anything, and there is no
Postgres, Redis or DynamoDB to run.

Tables: `orders`, `idempotency_records`, `stock_levels`, `inbound_requests`,
`outbound_events`, `counters`.

Note what is *not* stored: the integration's own configuration. `integrationMode`
and `orderStatusWrite` live in the environment, because they belong to WeAreDA's
side of the integration — the sandbox mirrors them so it can behave consistently
with what was registered, and `npm run cli -- integration:connect` is what
registers them.

### The tunnel is not part of the server

`scripts/tunnel.mjs` spawns `cloudflared` and prints a banner. The server has no
knowledge of it and runs identically without it. That keeps the tunnel a local
convenience rather than an architectural dependency.

### The mock receiver is a script, not a service

`scripts/mock-weareda.mjs` imitates the WeAreDA side — the webhook responses, the
connect plane (`connect` / `status` / `test-connection`), and the `order.status`
ladder — so you can exercise the outbound direction before you have a connection.
It is a development aid; nothing in `src/` depends on it.

It deliberately **duplicates** the rules rather than importing them from `src/`.
It stands in for the *other* side of the integration, and a stand-in that shares
its implementation with the thing it is testing proves less. That is why the
container table, the batch caps and now the mode table and the ladder appear
twice in this repository.

## Request lifecycle, inbound

1. `onRequest` stamps a start time.
2. The route's `preHandler` verifies credentials (`middleware/auth.ts`). A
   failure ends the request with `401` and never reaches the route.
3. The route delegates to a service and returns a plain object.
4. `onSend` prints the `WeAreDA -> Reseller` block with headers redacted, and
   writes a row into `inbound_requests`.

Routes attach explanatory notes with `addLogNote()` — that is how
"Duplicate delivery detected" and the stock-independence reminders reach the
log.

## Request lifecycle, outbound

1. A builder produces the event with a fresh `evt_...` id.
2. `assertSingleEventType` and the batch caps are checked in-process, so a
   contract violation fails before it becomes an HTTP round trip.
3. The body is serialized once and signed.
4. `fetch` sends those exact bytes with the three `X-WeAreDA-*` headers.
5. `5xx` and network errors are retried with exponential backoff, reusing the
   same event id and body so WeAreDA deduplicates the retry. `4xx` is never
   retried.
6. The result is logged as a `Reseller -> WeAreDA` block and written to
   `outbound_events`.
