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
  the two cancel paths.
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
| `weareda/` | Everything about the outbound wire format | Types, event builders, signing, read API. |
| `cli/`, `scenarios/` | Operator-facing entry points | Thin wrappers over `weareda/` and `services/`. |

The code is deliberately explicit rather than clever. There is no dependency
injection container, no ORM, no plugin system, and no code generation — a
developer porting this to PHP, Python, Java or .NET should be able to read a
file top-to-bottom and translate it.

## Key design decisions

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

### The tunnel is not part of the server

`scripts/tunnel.mjs` spawns `cloudflared` and prints a banner. The server has no
knowledge of it and runs identically without it. That keeps the tunnel a local
convenience rather than an architectural dependency.

### The mock receiver is a script, not a service

`scripts/mock-weareda.mjs` imitates the WeAreDA webhook responses so you can
exercise the outbound direction before you have a connection. It is a
development aid; nothing in `src/` depends on it.

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
