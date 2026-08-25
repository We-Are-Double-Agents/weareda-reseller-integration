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
no real company, customer or payment details.

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
