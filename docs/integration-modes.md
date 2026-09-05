# Integration modes and status write-back

Contract §1.1 (the four shapes), §2 (the two configuration scopes), §6.1 (what
the `orderStatusWrite` opt-in does to an inbound `order.status`) and §7 / §7.1
(`syncConfig` validation and its PATCH merge).

```bash
npm run scenario:integration-modes   # all four modes, started and called for real
npm run scenario:order-status        # the mapping, the ladder and the conflict
```

---

## Two scopes, two calls

Configuration lives at **two scopes**, and every field on this page belongs to
exactly one of them:

| Scope | Call | What lives there | Changing it affects |
|---|---|---|---|
| **Integration** — one per `(reseller, provider)` | `POST /api/v1/resellers/me/integrations` | `baseUrl`, `authType`, `credentialScope`, the credential, the webhook secret, `integrationMode`, `declaredCapabilities`, `syncConfig` | **every customer you serve** |
| **Tenant connection** — one per customer | `POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach` | `orderDeliveryStatus`, `orderStatusWrite`, `externalTenantId`, and the credential at `credentialScope: "tenant"` | that one customer |

So it is two calls — create once, attach per customer:

```bash
npm run cli -- integration:create --mode query_and_send   # once, reseller-wide
npm run cli -- integration:attach --order-status-write    # per customer
```

An **integration-level field in an attach body is a `400`** that names where it
belongs, and a per-tenant field in the integration body is the same `400` in
reverse. That guard is the point of the split: attaching one customer must never
reconfigure the others.

> **`POST .../integration/connect` was removed** — it answers
> `410 endpoint_removed` and names its two replacements. It took both scopes in
> one body against a tenant-scoped URL and upserted the shared half, so
> connecting one customer rewrote every other customer's `baseUrl`, auth type,
> credential scope, capabilities and `syncConfig` — and rotated the shared
> credential as a side effect. `npm run cli -- integration:connect` prints the
> same notice rather than making the call.

Later changes go to their own calls, never to a re-`connect`:

| Change | Call |
|---|---|
| Anything at integration scope | `PATCH /api/v1/resellers/me/integrations/{provider}` (§7.1) |
| The connector credential | `PUT /integrations/{provider}/credentials` |
| The webhook signing secret | `PUT /integrations/{provider}/webhook-secret` |
| One customer's settings | `PATCH .../tenants/{tenantId}/integration` |
| Detaching one customer | `POST .../tenants/{tenantId}/integration/disconnect` |

**Rotation is never a side effect.** A credential or a `webhookSecret` inside a
`PATCH` body is a `400` naming the `PUT` that does it.

---

## `integrationMode`

|  |  |
|---|---|
| **Where** | top level of the **integration** body (`POST /integrations`) |
| **Type** | string enum |
| **Values** | `query_and_send` · `receive_and_send` · `query_only` · `receive_only` |
| **Default** | `query_and_send` |
| **Scope** | stored per **reseller** — shared by all of its tenants |
| **Changing it** | `PATCH /integrations/{provider}`; omitting it leaves the stored value unchanged |
| **Contract** | §1.1, §2.1 |

### What it decides

Four outbound calls exist from WeAreDA to you. They split along **two
independent axes** — do we ever **read** from you, and do you ever **receive an
order**:

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

Five consequences worth stating plainly:

- **Inbound webhooks are not an axis.** You may publish `product.updated`,
  `stock.updated`, `order.status` and `invoice.issued` in *every* mode, as long as
  a `webhookSecret` is configured. The mode governs what **WeAreDA** does, not
  what you may send.
- **A mode without reads creates no sync schedule** — and deletes any schedule
  left over from a previous mode. `GET /products` is never called, and
  `POST …/integration/test-connection` returns `422` with
  `reason: "read_calls_disabled"`, because the connection test *is* a read.
- **A mode without order delivery switches `ordersWrite` off** in the effective
  capabilities, so an order never enters the delivery queue at all. Nothing is
  queued and later refused.
- **`receive_and_send` is not "no outbound calls".** Orders are still delivered.
  Delivering an order is a *send*, not a query.
- **`receive_only` still requires a `baseUrl`.** Nothing is ever sent to it; it is
  registered, not called. Omitting it is `400 invalid_request`.

### Worked example — one integration call per mode

```jsonc
// query_and_send — the default. WeAreDA reads your catalog and delivers orders.
POST /api/v1/resellers/me/integrations
{
  "provider": "generic_http",
  "baseUrl": "https://example.trycloudflare.com",
  "authType": "api_key",
  "credentialScope": "reseller",
  "externalCredentials": { "apiKey": "demo_secret" },
  "webhookSecret": "whsec_example",
  "integrationMode": "query_and_send"
}
```

```json
{
  "provider": "generic_http",
  "credentialScope": "reseller",
  "integrationMode": "query_and_send",
  "orderDeliveryEnabled": true,
  "productsSyncMode": "pull",
  "effectiveCapabilities": {
    "productsRead": true, "productsWrite": false, "stockRead": true,
    "stockWebhooks": true, "ordersWrite": true, "invoices": true
  },
  "connectedTenants": [],
  "syncSchedule": "daily"
}
```

A second create for the same provider is **`409 integration_exists`** — it is a
create, not an upsert, so it can never overwrite what your other customers are
running on.

```jsonc
// receive_and_send — no read endpoint, but orders still arrive.
{ …, "integrationMode": "receive_and_send" }
```
```json
{ "integrationMode": "receive_and_send", "orderDeliveryEnabled": true,
  "productsSyncMode": "push", "syncSchedule": null }
```

```jsonc
// query_only — read from, never sent an order.
{ …, "integrationMode": "query_only" }
```
```json
{ "integrationMode": "query_only", "orderDeliveryEnabled": false,
  "productsSyncMode": "pull",
  "effectiveCapabilities": { "ordersWrite": false, … } }
```

```jsonc
// receive_only — publish-only. baseUrl is still required.
{ …, "integrationMode": "receive_only" }
```
```json
{ "integrationMode": "receive_only", "orderDeliveryEnabled": false,
  "productsSyncMode": "push", "syncSchedule": null }
```

From this sandbox:

```bash
npm run cli -- integration:create --mode receive_and_send
npm run cli -- integration:attach
npm run cli -- integration:status
npm run cli -- integration:test          # 422 read_calls_disabled in a receive_* mode
```

### Running the sandbox in a mode

`INTEGRATION_MODE` makes the sandbox behave the way the registration says it
will: it registers **only** the routes its mode receives.

```bash
INTEGRATION_MODE=receive_only npm run dev

curl -H "X-API-Key: demo_secret" http://localhost:3000/           # 404
curl -H "X-API-Key: demo_secret" http://localhost:3000/products   # 404
curl -X POST http://localhost:3000/orders -H "X-API-Key: demo_secret"   # 404

npm run cli -- product-update --all    # still works, in every mode
npm run cli -- stock P-1001 37         # still works, in every mode
```

That is the point of the `receive_*` modes: a reseller with **no read endpoint at
all** is a complete, working integration.

### The catalog transport is derived, not chosen

`productsSyncMode` is a **response** field. It follows from the mode — `pull` for
`query_*`, `push` for `receive_*` — and you never send it.

| What you send | What happens |
|---|---|
| nothing | the mode decides; the response tells you which |
| `productsSyncMode` at the **top level** | **silently dropped.** No error, no effect. It is a response field. |
| `syncConfig.products.mode` that **agrees** with the mode | accepted, redundant |
| `syncConfig.products.mode` that **contradicts** the mode | `400 invalid_sync_config` |

```jsonc
{ "integrationMode": "query_and_send", "syncConfig": { "products": { "mode": "push" } } }
```
```
400 invalid_sync_config
syncConfig.products.mode "push" contradicts integrationMode "query_and_send",
which derives "pull". The mode decides the catalog transport - this is a 400,
not a precedence rule. Remove products.mode, or change the mode.
```

### Changing the mode later

`PATCH /integrations/{provider}` recomputes your effective capabilities and
**reconciles the sync schedule of every attached customer**, so the response
carries the blast radius:

```jsonc
PATCH /api/v1/resellers/me/integrations/generic_http
{ "integrationMode": "receive_and_send" }
```
```json
{ "integrationMode": "receive_and_send", "productsSyncMode": "push",
  "affectedTenants": 3, "schedulesReconciled": 3 }
```

It is refused with **`409 order_status_write_conflict`** when the new mode would
strand customers who opted into `orderStatusWrite` — the response names them.
Turn the flag off on those tenants first.

### Back-compat

An integration configured before `integrationMode` existed carries only
`syncConfig.products.mode`. A stored `"push"` resolves to **`receive_and_send`** —
reads off, orders still delivered. Anything else resolves to `query_and_send`.
There is no data migration; the resolution happens on read.

---

## `orderStatusWrite`

|  |  |
|---|---|
| **Where** | top level of the **attach** body (`POST .../integration/attach`) |
| **Type** | **strict** boolean — the string `"true"` is a `400` |
| **Default** | `false` |
| **Scope** | stored per **tenant** |
| **Changing it** | `PATCH .../tenants/{tenantId}/integration`; omitting it leaves the stored value unchanged |
| **Requires** | an `integrationMode` that delivers orders |
| **Contract** | §2.2, §6.1 |

Previously an inbound `order.status` webhook moved only
`orders.integration_status` and left the customer-facing `orders.status` frozen.
With this opt-in on, it moves **both**, in one atomic write, and fires the same
downstream effects a manual status change in the CRM fires: alert notifications
and conversation-lifecycle automation.

```jsonc
POST /api/v1/resellers/me/tenants/{tenantId}/integration/attach
{
  "provider": "generic_http",
  "orderDeliveryStatus": "confirmed",
  "orderStatusWrite": true,
  "externalTenantId": "cust-7"
}
```

Note what is **not** in that body: no `baseUrl`, no `integrationMode`, no
`syncConfig`. Those are reseller-wide, and sending one here is a `400` naming the
integration call it belongs to.

The mapping table, the ladder, the exceptions and the conflict rule are in
[orders.md](orders.md#reporting-progress-back) — they belong with the event that
uses them.

### Cross-field validation

`orderStatusWrite: true` with `query_only` or `receive_only` is a **`400`**:

```jsonc
{ "integrationMode": "query_only", "orderStatusWrite": true }
```
```
400 invalid_request
orderStatusWrite requires an integrationMode that delivers orders —
'query_only' never sends this reseller an order to report a status on
```

Those resellers receive no order, so they have none to report a status on.

### Why the two settings are otherwise independent

They answer different questions, at different scopes:

| | `integrationMode` | `orderStatusWrite` |
|---|---|---|
| Scope | per **reseller** (all its tenants) | per **tenant** |
| Call | `POST /integrations` | `POST .../integration/attach` |
| Question | infrastructure topology — which calls happen | data authority — may an external event rewrite a column the tenant's staff see and edit |

Choosing `receive_and_send` does **not** imply `orderStatusWrite`. A reseller can
run a push-only, order-receiving integration and still leave every tenant's
customer-facing order status entirely in the tenant's hands. That is also why a
mode change is refused rather than applied when it would strand a tenant who
opted in: a reseller-wide change must never silently rewrite what one customer
chose.

---

## `declaredCapabilities`

|  |  |
|---|---|
| **Where** | top level of the **integration** body |
| **Type** | object with **exactly** these six boolean keys |
| **Keys** | `productsRead` · `productsWrite` · `stockRead` · `stockWebhooks` · `ordersWrite` · `invoices` |
| **Default** | absent |
| **Effect** | **none** |
| **Contract** | §2 |

Anything else in it is `400 invalid_request`. Its presence never enables
anything.

Contract §2 names four capabilities as the platform's gates — `productsRead`,
`stockRead`, `ordersWrite`, `invoices`. `declaredCapabilities` additionally
accepts `productsWrite` and `stockWebhooks`, which no `generic_http` connector
uses. That is harmless precisely because the declaration enables nothing.

Effective capabilities are computed as

```
connector support  ∩  platform ceiling  ∩  mode
```

and your declaration is **not an input** to that — a reseller cannot self-grant a
capability. The mode's only capability effect is `ordersWrite`, switched off by
`query_only` and `receive_only`.

```jsonc
{ "integrationMode": "query_only",
  "declaredCapabilities": { "ordersWrite": true, "productsWrite": true } }
```
```json
{ "integrationMode": "query_only",
  "effectiveCapabilities": { "ordersWrite": false, "productsWrite": false, … } }
```

`ordersWrite` is off because the mode says so; `productsWrite` is off because no
`generic_http` connector supports it — there is no endpoint in the contract for
WeAreDA to write products *to* you. The declaration changed neither.

Note what the mode does **not** switch off: `productsRead`. That one permission
authorizes your catalog in **both** directions, and the push transport of a
`receive_*` mode still needs it. "Reads off" is a statement about which HTTP calls
WeAreDA makes, not about which permissions exist.

---

## Field placement — the mistakes that cost real debugging time

| Mistake | Result |
|---|---|
| `orderStatusWrite` / `orderDeliveryStatus` / `externalTenantId` in the **integration** body | `400 invalid_request`, naming the attach call |
| `baseUrl` / `integrationMode` / `credentialScope` / `syncConfig` / `declaredCapabilities` in the **attach** body | `400 invalid_request`, naming the integration call |
| `webhookSecret` in an attach or `PATCH` body | `400 invalid_request`, naming `PUT .../webhook-secret` |
| `externalCredentials` in a `PATCH` body | `400 invalid_request`, naming `PUT .../credentials` |
| `externalCredentials` at creation with `credentialScope: "tenant"` | `400 invalid_request` — it comes with each attach |
| no `externalCredentials` at creation with `credentialScope: "reseller"` | `400 invalid_request` |
| a second `POST /integrations` for the same provider | `409 integration_exists` |
| `integrationMode` inside `declaredCapabilities` | `400 invalid_request` |
| `orderStatusWrite` inside `declaredCapabilities` | `400 invalid_request` |
| `integrationMode` inside `syncConfig` | `400 invalid_sync_config` |
| `orderStatusWrite` inside `syncConfig` | `400 invalid_sync_config` |
| `orderStatusWrite: "true"` (a string) | `400 invalid_request` |
| `productsSyncMode` at the top level | **silently dropped** — no error, no effect |
| any other unknown key at the top level | **silently dropped** |
| any unknown key inside `syncConfig` | `400 invalid_sync_config` |
| omitting a field on a re-attach or a `PATCH` | stored value unchanged |

The asymmetry is the trap: `syncConfig` is a strict whitelist because it steers
outbound request construction, so a typo there fails loudly when you send it. The
top level of the body is not, so an unknown key there fails **silently** and
looks exactly like a feature that does not work.

The scope guard, by contrast, is never silent in either direction — which is the
whole reason the configuration was split. Under the old `connect` a `baseUrl`
sent while attaching one customer was simply *applied*, to all of them.

> **One place the contract reads softer than this table.** The `syncConfig`
> example in contract §7 shows `integrationMode` as a key with the comment
> *"prefer setting this at the TOP LEVEL of the request body"*, which could be
> read as "accepted there, just discouraged". This reference implements the
> strict reading — `syncConfig.integrationMode` is `400 invalid_sync_config`,
> with a message pointing at the top level — because §7 is otherwise a strict
> whitelist and because a setting that is silently honoured in two places is
> exactly the kind of ambiguity that costs an afternoon. If you find the real API
> accepting it there, treat the top level as canonical regardless: that is where
> §1.1 and §2 put it.

This repository refuses to let you find that out the slow way:
`validateCreateIntegrationBody()`, `validateAttachBody()` and
`validatePatchIntegrationBody()` in
[`src/weareda/integration-mode.ts`](../src/weareda/integration-mode.ts) apply
every rule above locally, before the request leaves the process, and
`npm run cli -- integration:create` / `integration:attach` print a warning naming
any top-level key WeAreDA would drop.

---

## Editing `syncConfig` later — the merge that is not a deep merge

`syncConfig` belongs to the integration, so one value is shared by every customer
you serve. `PATCH /integrations/{provider}` edits it by the rules of contract
§7.1:

- only the **top-level keys you name** are touched; the rest are kept,
- a named section is **replaced whole**, not deep-merged,
- `null` **deletes** a key, resetting it to its default,
- the **merged result** is validated by the same rules a create would apply, so a
  patch can never store something a create would have refused.

```jsonc
// stored: { "products": { "path": "/products", "pageSize": 200 },
//           "orders": { "requiresTaxId": true }, "frequency": "daily" }

PATCH /api/v1/resellers/me/integrations/generic_http
{ "syncConfig": { "products": { "path": "/v2" } } }

// stored now: { "products": { "path": "/v2" },        <- pageSize is GONE
//               "orders": { "requiresTaxId": true }, "frequency": "daily" }
```

So read the current section back first:

```bash
npm run cli -- integration:get       # GET /integrations/{provider}
npm run cli -- integration:patch --sync-config '{"products":{"path":"/v2","pageSize":200}}'
```

`products.mode` is never settable through a patch: it is the legacy spelling of
`integrationMode`, which supersedes it.

Everything except the schedule keys takes effect on your next call, with nothing
to redeploy. Changing `enabled`, `frequency`, `scheduleExpression` or
`integrationMode` reconciles every attached customer's schedule, and the response
says how many (`affectedTenants`, `schedulesReconciled`).

---

## Error reference

| Status | Body | Cause |
|---|---|---|
| `400` | `invalid_request` | unknown `integrationMode`; `orderStatusWrite` not a boolean; `orderStatusWrite` on a mode without order delivery; a bad `declaredCapabilities` key or value; missing `baseUrl`; a field of the **other scope**; a credential where its `credentialScope` does not put it |
| `400` | `invalid_sync_config` | unknown key inside `syncConfig`; a value outside the §7 table (absolute `path`, `pageSize` over 500, a `documentHosts` entry that is a URL, port, path or IP literal, …); a `products.mode` contradicting the mode, or set at all in a `PATCH` |
| `404` | `integration_not_found` | attaching a customer to a provider you have not created yet |
| `409` | `integration_exists` | a second `POST /integrations` for the same provider — it is a create, not an upsert |
| `409` | `order_status_write_conflict` | a mode change that would strand customers who opted into `orderStatusWrite` |
| `410` | `endpoint_removed` | the retired `POST .../integration/connect` |
| `422` | `{ "reason": "read_calls_disabled" }` | `POST …/integration/test-connection` in a `receive_*` mode |

Operation-level failures (they surface on the operation, not on connect) are
listed in [orders.md](orders.md#operation-result-diagnostics):
`unknown_order_state`, `order_not_found`, `order_status_conflict`,
`integration_disabled`, `read_calls_disabled`, `order_delivery_disabled`.
