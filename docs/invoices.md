# Invoices

Contract §6.3, plus §11.6 for reading invoices back.

```json
{
  "type": "invoice.issued",
  "id": "evt_inv_7…",
  "invoice": {
    "external_invoice_id": "INV-2026-000123",
    "number": "A-0007",
    "status": "paid",
    "currency": "USD",
    "total": 105.00,
    "issued_at": "2026-08-25T10:00:00Z",
    "external_order_id": "SO-10001",
    "document_url": "https://files.your-erp.com/inv/INV-2026-000123.pdf"
  }
}
```

```bash
npm run cli -- invoice SO-10001
npm run cli -- invoice SO-10001 --status paid --total 210.50 --invoice-id INV-2026-000999
```

Link the invoice to its order with `external_order_id` (the id you returned from
`POST /orders`) or `order_number`.

`status` is one of `issued | paid | cancelled | void`.

---

## Who you are invoicing — the order's fiscal identity

Contract §4.3. The delivered order carries a `customer`, and with it the
contact's fiscal identification when the tenant captured one:

```json
"customer": {
  "name": "Ada Lovelace",
  "tax_id": { "type": "CUIT", "value": "20-12345678-9", "country": "AR" }
}
```

`npm run cli -- invoice SO-10001` prints it before sending, masked:

```
Invoicing against (contract 4.3, a snapshot taken when the order was created):
  Order:    SO-10001 (ORD-1042)
  Customer: Ada Lovelace
  Tax id:   CUIT 20-******78-9 (AR)
            Stored in full locally; masked here and in every log.
```

Three things matter here, and all three are easy to get wrong.

**It is a snapshot, not a live read** (§4.3.1). The values were copied onto the
order when it was created. If the tenant corrects the contact tomorrow, this
invoice keeps the identity it was issued under, and only *new* orders carry the
new value — an invoice is issued against a fiscal identity, and that identity
must not change retroactively. Never refresh a stored order from a later read of
the customer.

**`tax_id.type` is a free token, not an enum.** `CUIT`, `CPF`, `NIF`, `RFC`,
`KENNITALA`, whatever the next country uses. Your invoice should print what it
was given, not what it recognises.

**The event itself carries no customer.** `invoice.issued` links to the order by
`external_order_id` / `order_number`; WeAreDA already holds the snapshot. There
is nothing about the customer to send back.

### When the order has no fiscal id

An order with `customer.tax_id: null` — or with no `customer` at all — is an
ordinary order and must be accepted. The CLI says so plainly:

```
  Tax id:   (none)

  NOTE: this order carries no fiscal identification, which is NORMAL and
        not an error - customer.tax_id is null when the contact has none.
        ...
        If you cannot invoice without one, set
          syncConfig.orders.requiresTaxId: true   (contract 4.3.2)
```

If your billing genuinely cannot issue an invoice without a fiscal id, that flag
is the answer (§4.3.2):

```bash
npm run cli -- integration:connect --requires-tax-id
```

WeAreDA then never delivers such an order — it is simply not yet eligible — and
delivers it automatically, within a minute, once the tenant completes the
contact. Nothing is parked and nothing has to be re-queued.

**Rejecting the delivery is the wrong answer.** A non-auth `4xx` is not retried,
so it turns an order that would have arrived complete into a manual-review
ticket. See [orders.md](orders.md#the-customer-and-its-fiscal-id).

### Masking

Fiscal identifiers are sensitive customer data (§11.8). WeAreDA masks them in
its operational logs and asks you to do the same. This sandbox keeps the real
value on the order — you cannot invoice against a masked one — and masks it
everywhere it is rendered: the request log, the event history, `GET
/debug/orders` and every CLI command.

---

## Idempotency

Re-sending the same `external_invoice_id` **updates the invoice in place** — an
idempotent upsert. Use a stable id from your billing system and you can correct
an invoice by simply re-sending it.

Note this is upsert on the invoice id, which is separate from webhook dedup on
the event id: a *new* `evt_…` carrying the *same* `external_invoice_id` is
processed and updates the invoice.

---

## The document

`document_url` is optional. When present it must:

- serve a **PDF**,
- be reachable **over HTTPS** by WeAreDA, and
- live on a host allow-listed in `sync_config.documentHosts` (bare hostnames,
  up to 10 — never a URL, port or path).

WeAreDA fetches it (size-capped) and stores a private copy. **If the fetch
fails the invoice is still recorded**, with its document marked `failed`. So a
broken URL costs you the PDF, not the invoice.

`document_status` is one of `none | stored | failed`.

### Testing the document flow locally

The sandbox serves a real PDF fixture:

```
GET /fixtures/invoices/demo.pdf
```

That route is deliberately unauthenticated — WeAreDA fetches document URLs
without your connector credentials.

To make it fetchable from outside:

```bash
npm run dev
npm run tunnel                      # copy the https URL
```

```env
PUBLIC_BASE_URL=https://example.trycloudflare.com
```

Restart, and `npm run cli -- invoice SO-10001` emits

```
document_url: https://example.trycloudflare.com/fixtures/invoices/demo.pdf
```

which exercises the complete WeAreDA invoice-document fetch. Remember to add
that tunnel host to `documentHosts` in your `sync_config`.

Without a tunnel the CLI warns you rather than silently sending an unreachable
URL:

```
WARNING: that URL is not HTTPS, so WeAreDA cannot fetch it.
         The invoice would still be recorded, with document_status "failed".
         Run `npm run tunnel` and set PUBLIC_BASE_URL to the tunnel URL.
```

Fixtures live in `fixtures/invoices/`: `demo.pdf` and `demo-invoice.json`, which
holds the invoice metadata the CLI uses as its defaults. Both are sample data —
no real company, customer, fiscal identifier or payment details.

---

## What an invoice does *not* do

- It **does not move the order's status**. An invoiced order is not thereby
  `completed`; only an `order.status` event does that.
- It **does not touch stock**.

It attaches the invoice, and its stored PDF if you gave one, to the order.

---

## Capability gating

Invoice ingest is gated on the **`ordersWrite`** capability, not on a separate
`invoices` flag. `invoices` is not yet enabled at the platform capability
ceiling, so it is reported `false` in `effectiveCapabilities` even while invoice
events are accepted. If you see `invoices: false` in your connect response, that
is expected and does not mean invoice events are rejected.

---

## Reading invoices back

Contract §11.6, a different plane — the `X-Reseller-Key` management API:

```bash
npm run cli -- orders:invoices <wearedaOrderId>
npm run cli -- invoice:document <invoiceId>
```

`invoices/{invoiceId}/document` returns a **short-lived presigned URL**:

```json
{ "document_url": "https://…", "kind": "stored", "mime": "application/pdf" }
```

The S3 bucket/key is never returned, nor is a long-lived direct URL. A missing
document returns a controlled `404`. This download is audited
(`reseller.invoice.document_requested`).
