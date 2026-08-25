#!/usr/bin/env node
/**
 * A stand-in for the WeAreDA webhook endpoint, for local testing.
 *
 *   npm run mock:weareda
 *
 * Then, in .env:
 *   WEAREDA_WEBHOOK_URL=http://localhost:4000/api/v1/reseller-webhooks/demo-connection
 *   WEAREDA_WEBHOOK_SECRET=whsec_example
 *
 * and your CLI, scenarios and Postman webhook requests stop being dry runs.
 *
 * This is NOT WeAreDA. It is a faithful-enough imitation of the response
 * contract (section 6.0) so you can see each outcome for yourself:
 *
 *   202 { accepted: true, operationId }    queued
 *   200 { deduped: true, operationId }     duplicate X-WeAreDA-Event-Id
 *   400 { error: 'unsupported_event' }     unknown/missing top-level type
 *   400 { error: 'multiple_event_types' }  two types, or a batch envelope
 *   400 { error: 'too_many_items', max }   product.updated over 500
 *   401 { error: 'unauthorized' }          bad signature or no secret
 *   401 { error: 'stale_timestamp' }       outside the +/-5 minute window
 *
 * Like the real endpoint it verifies the HMAC over the RAW body bytes, and
 * processing is asynchronous in the sense that 202 means "queued".
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const SECRET = process.env.WEAREDA_WEBHOOK_SECRET || 'whsec_example';
const REPLAY_WINDOW_SECONDS = 300;
const MAX_PRODUCTS = 500;
const MAX_BYTES = 512 * 1024;

const seenEventIds = new Map(); // `${type}:${id}` -> operationId
const RULE = '-'.repeat(50);

function verify(rawBody, signature) {
  if (!signature) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex')}`,
    'utf8',
  );
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function timestampIsFresh(header) {
  if (!header) return true; // the header is optional
  const value = Number(header);
  if (!Number.isFinite(value)) return false;
  // Accept seconds or milliseconds, as the contract allows both.
  const seconds = value > 1e11 ? value / 1000 : value;
  return Math.abs(Date.now() / 1000 - seconds) <= REPLAY_WINDOW_SECONDS;
}

const CONTAINERS = {
  'order.status': 'order',
  'stock.updated': 'items',
  'product.updated': 'products',
  'invoice.issued': 'invoice',
};

function classify(event) {
  if (event && typeof event === 'object' && 'events' in event) {
    return { error: 'multiple_event_types' };
  }
  const type = event?.type;
  if (typeof type !== 'string' || !(type in CONTAINERS)) {
    return { error: 'unsupported_event' };
  }
  const foreign = Object.entries(CONTAINERS).filter(
    ([otherType, container]) => otherType !== type && container in event,
  );
  if (foreign.length > 0) return { error: 'multiple_event_types' };

  if (
    type === 'product.updated' &&
    Array.isArray(event.products) &&
    event.products.length > MAX_PRODUCTS
  ) {
    return { error: 'too_many_items', max: MAX_PRODUCTS };
  }
  return { type };
}

function describe(event) {
  switch (event.type) {
    case 'stock.updated':
      return (event.items ?? [])
        .map((item) => {
          const ref = item.external_variant_id ?? item.external_product_id ?? item.sku;
          return `    ${ref} -> ${item.quantity} (absolute)`;
        })
        .join('\n');
    case 'order.status':
      return `    ${event.order?.external_order_id ?? event.order?.order_number} -> ${event.order?.state}`;
    case 'product.updated':
      return (
        `    ${event.products?.length} product(s): ` +
        (event.products ?? [])
          .map((p) => `${p.id}${p.status === 'archived' ? ' (archived)' : ''}`)
          .join(', ')
      );
    case 'invoice.issued':
      return (
        `    ${event.invoice?.external_invoice_id} ${event.invoice?.total} ${event.invoice?.currency}` +
        (event.invoice?.document_url ? `\n    document: ${event.invoice.document_url}` : '')
      );
    default:
      return '';
  }
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const send = (status, body, note) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload);
      console.log(
        [
          RULE,
          'MOCK WeAreDA received a webhook',
          'Direction: Reseller -> WeAreDA',
          `${request.method} ${request.url}`,
          `Event id:  ${request.headers['x-weareda-event-id'] ?? '(none)'}`,
          `Signature: ${request.headers['x-weareda-signature'] ? 'present' : '(none)'}`,
          `Bytes:     ${Buffer.byteLength(rawBody, 'utf8')}`,
          note ? note : '',
          `Response:  ${status} ${payload}`,
          RULE,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    };

    if (request.method !== 'POST') {
      return send(404, { error: 'not_found' });
    }

    if (!verify(rawBody, request.headers['x-weareda-signature'])) {
      return send(401, { error: 'unauthorized' }, 'Signature does not match the raw body bytes.');
    }
    if (!timestampIsFresh(request.headers['x-weareda-timestamp'])) {
      return send(401, { error: 'stale_timestamp' }, 'Outside the +/-5 minute replay window.');
    }
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BYTES) {
      return send(400, { error: 'too_many_items', max: MAX_PRODUCTS }, 'Body over 512 KB.');
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return send(400, { error: 'unsupported_event' }, 'Body is not JSON.');
    }

    const verdict = classify(event);
    if (verdict.error) {
      return send(400, verdict, `Rejected whole - nothing applied.`);
    }

    const eventId = String(request.headers['x-weareda-event-id'] ?? event.id ?? '');
    // Dedup is scoped to connection + event type + event id (contract 5).
    const key = `${request.url}:${verdict.type}:${eventId}`;
    if (seenEventIds.has(key)) {
      return send(200, { deduped: true, operationId: seenEventIds.get(key) }, 'Already processed.');
    }

    const operationId = `op_${randomUUID()}`;
    seenEventIds.set(key, operationId);
    send(202, { accepted: true, operationId }, `Queued:\n${describe(event)}`);
  });
});

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('MOCK WeAreDA webhook endpoint');
  console.log('='.repeat(50));
  console.log('');
  console.log('This is NOT WeAreDA. It imitates the response contract (6.0) so');
  console.log('you can test the Reseller -> WeAreDA direction locally.');
  console.log('');
  console.log('Put these in your .env:');
  console.log('');
  console.log(
    `  WEAREDA_WEBHOOK_URL=http://localhost:${PORT}/api/v1/reseller-webhooks/demo-connection`,
  );
  console.log(`  WEAREDA_WEBHOOK_SECRET=${SECRET}`);
  console.log('');
  console.log('Then run, for example:  npm run cli -- stock P-1001 37 V-2001 5');
  console.log('='.repeat(50));
});
