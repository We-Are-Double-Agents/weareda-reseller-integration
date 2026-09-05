# Authentication

Contract §3 and §11.1.

There are **three** authentication contexts in this integration. They use
different credentials and travel in different directions. Confusing them is the
most common source of `401`s.

```
 1. WeAreDA -> Reseller            X-API-Key (or bearer / basic / custom)
    inbound, to your server        credential: RESELLER_API_KEY

 2. Reseller -> WeAreDA            X-WeAreDA-Signature: sha256=<hmac>
    outbound webhook               credential: WEAREDA_WEBHOOK_SECRET

 3. Reseller -> WeAreDA            X-Reseller-Key
    outbound management/read API   credential: WEAREDA_RESELLER_KEY
```

A useful way to keep them straight:

- (1) is a **password you gave WeAreDA**, so it can prove it is WeAreDA.
- (2) is a **shared secret used to sign**, so WeAreDA can prove the webhook came
  from you. It is never sent as a token — only the signature travels.
- (3) is a **plain API key for a different product surface**: WeAreDA's
  reseller management backend, which has nothing to do with the connector.

---

## 1. WeAreDA -> Reseller (inbound)

WeAreDA attaches whatever you registered on the integration (or, at
`credentialScope: "tenant"`, whatever you sent when attaching that customer),
according to
`authType`:

| `authType` | Header WeAreDA sends |
|---|---|
| `api_key` (default) | `X-API-Key: <apiKey>` |
| `bearer` | `Authorization: Bearer <accessToken \| apiKey>` |
| `basic` | `Authorization: Basic base64(clientId:clientSecret)` |
| `custom` | an arbitrary header map you supplied, e.g. `X-Auth-Token: ...` |

Every outbound request also carries `Accept: application/json`; writes add
`Content-Type: application/json` and an idempotency header.

### In this sandbox

The default is `api_key`. Switch with `RESELLER_AUTH_MODE`:

```env
RESELLER_AUTH_MODE=api_key     # X-API-Key: <RESELLER_API_KEY>
RESELLER_AUTH_MODE=bearer      # Authorization: Bearer <RESELLER_API_KEY>
RESELLER_AUTH_MODE=basic       # Authorization: Basic base64(user:password)
RESELLER_AUTH_MODE=custom      # <RESELLER_AUTH_HEADER>: <RESELLER_API_KEY>
RESELLER_AUTH_MODE=none        # no auth - local experiments only
```

All four contract mechanisms are implemented and tested, so you can verify your
real configuration before registering it.

### Replacing the mechanism

`src/middleware/auth.ts` is one file with one function to change:

```ts
export function verifyCredentials(request: FastifyRequest, config: AppConfig): boolean
```

Return `true` to accept. Everything else — which routes are protected, what a
failure returns — stays as it is. Comparisons use `timingSafeEqual`, which is
worth keeping if you swap in your own scheme.

### What a failure means to WeAreDA

`401` and `403` are **not retried**. The order (or sync) is routed to
`manual_review` for a human to look at. So return `401` only when the credential
really is wrong — never as a generic error.

`5xx` and timeouts, by contrast, *are* retried with backoff (up to 5 attempts),
then dead-lettered.

---

## 2. Reseller -> WeAreDA webhook (outbound)

You sign the request body with the `webhookSecret` you registered:

```
X-WeAreDA-Signature: sha256=<hex HMAC_SHA256(rawBody, webhookSecret)>
X-WeAreDA-Event-Id:  <your unique event id>        # dedup key; recommended
X-WeAreDA-Timestamp: <unix seconds or ms>          # optional; +/-5 min window
Content-Type: application/json
```

The rules that matter:

- The HMAC is over the **exact raw body bytes you send**. Sign the string you
  are about to POST — do not re-serialize it afterwards.
- Verification on WeAreDA's side is constant-time over the untouched bytes.
- A connection with **no** configured webhook secret is rejected with `401`;
  unauthenticated webhooks are never accepted.
- `X-WeAreDA-Event-Id` is the idempotency key of the event. Resending the same
  id returns `200 {deduped: true}`. Omit it and WeAreDA derives one from the
  body hash, so identical bodies still dedup.

```js
const body = JSON.stringify(event);   // once
const sig  = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
await fetch(webhookUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-WeAreDA-Signature': `sha256=${sig}`,
    'X-WeAreDA-Event-Id': event.id,
  },
  body,                                // the SAME string
});
```

See [webhooks.md](webhooks.md) for delivery, retries and dedup.

---

## 3. Reseller -> WeAreDA management API (outbound)

Contract §2 (configuring the integration) and §11 (reading tenant orders). A
different plane from §4–§6 entirely.

```http
GET   /api/v1/resellers/me/tenants/{tenantId}/orders
POST  /api/v1/resellers/me/integrations                             (§2.1)
POST  /api/v1/resellers/me/tenants/{tenantId}/integration/attach    (§2.2)
X-Reseller-Key: rsk_...
```

This is the plane that carries `integrationMode` and `orderStatusWrite` — both
configuration scopes, their `status` echo, `test-connection`, the `PATCH` of
§7.1 and the two rotation `PUT`s all authenticate with this key. Registering an
integration is a management action, not a connector one, so it never touches the
HMAC or the inbound credential.

Note that rotating the connector credential
(`PUT /integrations/{provider}/credentials`) and rotating the signing secret
(`PUT /integrations/{provider}/webhook-secret`) are themselves calls on **this**
plane: you authenticate with `X-Reseller-Key` to change the other two
credentials, and never by re-sending them inside some other body.

- Authenticated by `X-Reseller-Key` — **not** the HMAC signature, and **not**
  your inbound connector credential.
- The tenant comes from the **path** and must belong to you. `X-Tenant-Id` is
  never used.
- Gated on the `canViewTenantOrders` reseller permission.

Each request is validated in order: key valid and reseller active; permission
granted; tenant exists and belongs to you; and for a single order, the order
belongs to that tenant. Cross-reseller and cross-tenant reads are impossible.

Error model:

| HTTP | `reason` | When |
|---|---|---|
| 401 | `invalid_reseller_key` | missing/invalid `X-Reseller-Key` |
| 403 | `reseller_disabled` | reseller account disabled |
| 403 | `orders_permission_denied` | `canViewTenantOrders` not granted |
| 403 | `tenant_ownership_mismatch` | tenant belongs to another reseller |
| 404 | `tenant_not_found` / `order_not_found` | unknown tenant / order not in this tenant |
| 400 | `invalid_filter` / `invalid_cursor` | bad filter value / tampered cursor |

Client: `src/weareda/reseller-api-client.ts`. CLI: `npm run cli -- orders:list`,
`npm run cli -- integration:create`, `npm run cli -- integration:attach`.

---

## Secrets hygiene in this sandbox

- `.env` is gitignored; `.env.example` holds only placeholder values.
- Log blocks redact `authorization`, `x-api-key`, `x-reseller-key`,
  `x-weareda-signature` and cookies.
- The CLI masks every credential it mentions (`demo***cret`).
- The local event history stores payloads and statuses, but never credentials,
  signatures or secrets — asserted by a test.
