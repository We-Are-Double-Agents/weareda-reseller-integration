/**
 * WeAreDA webhook client - direction: Reseller -> WeAreDA (contract 3.2, 6).
 *
 * ============================================================================
 * THE ONE RULE THAT BREAKS MOST INTEGRATIONS
 * ============================================================================
 * The signature is an HMAC-SHA256 over the EXACT RAW BYTES of the request body.
 * So the body is serialized ONCE, that string is signed, and that same string
 * is what goes on the wire:
 *
 *     const body = JSON.stringify(event);   // serialize once
 *     const sig  = hmac(body, secret);      // sign that string
 *     fetch(url, { body });                 // send that same string
 *
 * Never `JSON.stringify` again after signing. Key order, whitespace, unicode
 * escaping - any of it differing between the signed string and the sent string
 * produces `401 unauthorized` on WeAreDA's side.
 * ============================================================================
 *
 * Also enforced here, from contract 6.0: ONE EVENT TYPE PER HTTP REQUEST.
 * The API of this module makes it impossible to put `order.status` and
 * `stock.updated` in the same call.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { isoNow, newEventId } from '../lib/ids.js';
import { logOutboundWebhook } from '../lib/logger.js';
import type { EventLog } from '../services/event-log.js';
import {
  EVENT_CONTAINER,
  PRODUCT_BATCH_MAX_BYTES,
  PRODUCT_BATCH_MAX_ITEMS,
  type WeAreDAEvent,
  type WeAreDAEventType,
  type WebhookResponseBody,
} from './types.js';

export interface DeliveryResult {
  /** The event id sent as X-WeAreDA-Event-Id. Retries reuse it. */
  eventId: string;
  eventType: WeAreDAEventType;
  timestamp: string;
  /** The exact string that was signed and sent. */
  body: string;
  url: string;
  attempts: number;
  statusCode: number | null;
  statusText: string | null;
  responseBody: WebhookResponseBody | string | null;
  operationId: string | null;
  /** Contract 6.0: 200 {deduped:true} - this event id was already processed. */
  deduped: boolean;
  /** Contract 6.0: 202 {accepted:true} - QUEUED, not yet applied. */
  accepted: boolean;
  ok: boolean;
  error: string | null;
  dryRun: boolean;
}

export interface SendOptions {
  /** Print the signed request without sending it (also implied when no URL is configured). */
  dryRun?: boolean;
  /** Overrides the generated event id - use to deliberately replay an id and observe dedup. */
  eventId?: string;
  /** Overrides the destination, e.g. a local receiver in tests. */
  url?: string;
  /** Omit X-WeAreDA-Timestamp (it is optional per contract 3.2). */
  omitTimestamp?: boolean;
  /** Deliberately corrupt the signature, to exercise WeAreDA's 401 path. */
  corruptSignature?: boolean;
}

export class WebhookConfigurationError extends Error {}
export class EventTooLargeError extends Error {}

/**
 * Computes the signature exactly as WeAreDA verifies it:
 *   sha256=<hex HMAC_SHA256(rawBody, webhookSecret)>
 */
export function computeSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * The verification WeAreDA performs on its side. Included so you can test your
 * signing locally (and so the test-suite can assert exact-bytes behaviour).
 * Comparison is constant-time, as on the real receiver.
 */
export function verifySignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(computeSignature(rawBody, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Guards contract 6.0 before anything leaves the process: exactly one top-level
 * `type` and exactly the one payload container that belongs to it.
 */
export function assertSingleEventType(event: Record<string, unknown>): void {
  // Checked first: a batch envelope is rejected as `multiple_event_types`,
  // not as `unsupported_event`, even though it has no top-level `type`.
  if ('events' in event) {
    throw new WebhookConfigurationError(
      'There is no batch envelope in this contract. Send N requests instead - ' +
        'WeAreDA would answer 400 multiple_event_types.',
    );
  }

  const type = event.type;
  if (typeof type !== 'string' || !(type in EVENT_CONTAINER)) {
    throw new WebhookConfigurationError(
      `Missing or unknown top-level "type" - WeAreDA would answer 400 unsupported_event. ` +
        `Expected one of: ${Object.keys(EVENT_CONTAINER).join(', ')}`,
    );
  }

  const own = EVENT_CONTAINER[type as WeAreDAEventType];
  const foreign = Object.entries(EVENT_CONTAINER)
    .filter(([otherType, container]) => otherType !== type && container in event)
    .map(([, container]) => container);

  if (foreign.length > 0) {
    throw new WebhookConfigurationError(
      `Event "${type}" also carries the container(s) [${foreign.join(', ')}] belonging to another ` +
        `event type. One event type per HTTP request - WeAreDA would answer 400 multiple_event_types.`,
    );
  }

  if (!(own in event)) {
    throw new WebhookConfigurationError(
      `Event "${type}" is missing its "${own}" payload container.`,
    );
  }
}

export class WeAreDAWebhookClient {
  constructor(
    private readonly config: AppConfig,
    private readonly eventLog?: EventLog,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.webhook.url && this.config.webhook.secret);
  }

  /**
   * Signs and delivers one event.
   *
   * Retries only on 5xx / network errors, reusing the SAME event id and the
   * SAME body so WeAreDA deduplicates the redelivery (contract 5). A 4xx is a
   * contract error on our side and is never retried.
   */
  async send(event: WeAreDAEvent, options: SendOptions = {}): Promise<DeliveryResult> {
    assertSingleEventType(event as unknown as Record<string, unknown>);

    if (event.type === 'product.updated') {
      const count = event.products.length;
      if (count > PRODUCT_BATCH_MAX_ITEMS) {
        throw new EventTooLargeError(
          `product.updated carries ${count} products; the per-event cap is ${PRODUCT_BATCH_MAX_ITEMS} ` +
            `(WeAreDA would answer 400 too_many_items). Page the batch like GET /products.`,
        );
      }
    }

    const url = options.url ?? this.config.webhook.url;
    const secret = this.config.webhook.secret;
    const dryRun = options.dryRun === true || !url || !secret;

    // Settle the event id BEFORE serializing, so the X-WeAreDA-Event-Id header
    // and the body's `id` can never disagree - WeAreDA dedupes on the header
    // but falls back to the body, and a mismatch between them is a debugging
    // nightmare nobody deserves.
    const eventId = options.eventId ?? event.id ?? newEventId();
    const payload = event.id === eventId ? event : { ...event, id: eventId };

    // ---- serialize ONCE. This exact string is signed and sent. -------------
    const body = JSON.stringify(payload);
    // -----------------------------------------------------------------------

    const byteLength = Buffer.byteLength(body, 'utf8');
    if (event.type === 'product.updated' && byteLength > PRODUCT_BATCH_MAX_BYTES) {
      throw new EventTooLargeError(
        `product.updated body is ${byteLength} bytes; the limit is ${PRODUCT_BATCH_MAX_BYTES} ` +
          `(512 KB). Split the batch into smaller pages.`,
      );
    }

    const timestampMs = Date.now();
    const timestampSeconds = Math.floor(timestampMs / 1000);

    const result: DeliveryResult = {
      eventId,
      eventType: event.type,
      timestamp: new Date(timestampMs).toISOString(),
      body,
      url: url || '(WEAREDA_WEBHOOK_URL not set)',
      attempts: 0,
      statusCode: null,
      statusText: null,
      responseBody: null,
      operationId: null,
      deduped: false,
      accepted: false,
      ok: false,
      error: null,
      dryRun,
    };

    if (dryRun) {
      logOutboundWebhook({
        url: result.url,
        method: 'POST',
        eventType: event.type,
        eventId,
        timestamp: result.timestamp,
        summary: summarize(event),
        body,
        dryRun: true,
      });
      this.eventLog?.recordOutbound({
        eventId,
        eventType: event.type,
        timestamp: result.timestamp,
        attempts: 0,
        dryRun: true,
        payload,
      });
      return result;
    }

    let signature = computeSignature(body, secret);
    if (options.corruptSignature) {
      signature = `sha256=${'0'.repeat(64)}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-WeAreDA-Signature': signature,
      'X-WeAreDA-Event-Id': eventId,
    };
    // Optional per contract 3.2; when present it must be inside a +/-5 minute
    // window or WeAreDA answers 401 stale_timestamp.
    if (!options.omitTimestamp) {
      headers['X-WeAreDA-Timestamp'] = String(timestampSeconds);
    }

    const maxAttempts = Math.max(1, this.config.webhook.maxAttempts);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result.attempts = attempt;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          // The SAME string that was signed above. Not a re-serialization.
          body,
          signal: AbortSignal.timeout(this.config.webhook.timeoutMs),
        });

        const text = await response.text();
        const parsed = safeParseJson(text);

        result.statusCode = response.status;
        result.statusText = response.statusText;
        result.responseBody = parsed ?? text;
        result.operationId = readOperationId(parsed);
        result.deduped = parsed?.deduped === true;
        result.accepted = response.status === 202 || parsed?.accepted === true;
        result.ok = response.ok;
        result.error = response.ok ? null : `HTTP ${response.status}`;

        const retryable = response.status >= 500;
        if (!retryable || attempt === maxAttempts) break;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.statusCode = null;
        if (attempt === maxAttempts) break;
      }

      // Exponential backoff between retries of the SAME event id.
      await sleep(250 * 2 ** (attempt - 1));
    }

    logOutboundWebhook({
      url,
      method: 'POST',
      eventType: event.type,
      eventId,
      timestamp: result.timestamp,
      summary: summarize(event),
      body,
      attempt: result.attempts,
      statusCode: result.statusCode ?? undefined,
      statusText: result.statusText ?? undefined,
      responseBody: result.responseBody ?? undefined,
      operationId: result.operationId,
      deduped: result.deduped,
      error: result.error ?? undefined,
    });

    this.eventLog?.recordOutbound({
      eventId,
      eventType: event.type,
      timestamp: result.timestamp,
      attempts: result.attempts,
      statusCode: result.statusCode,
      operationId: result.operationId,
      deduped: result.deduped,
      error: result.error,
      dryRun: false,
      payload,
      responseBody: result.responseBody,
    });

    return result;
  }
}

/** One or two lines describing the event's payload, for the outbound log block. */
function summarize(event: WeAreDAEvent): string[] {
  switch (event.type) {
    case 'stock.updated':
      return [
        'Items:',
        String(event.items.length),
        '(quantities are ABSOLUTE on-hand values, never deltas)',
      ];
    case 'product.updated':
      return [
        'Products:',
        String(event.products.length),
        `(cap: ${PRODUCT_BATCH_MAX_ITEMS} per event)`,
      ];
    case 'order.status':
      return [
        'Order:',
        `${event.order.external_order_id ?? event.order.order_number ?? '(unidentified)'} -> ${event.order.state}`,
      ];
    case 'invoice.issued':
      return [
        'Invoice:',
        `${event.invoice.external_invoice_id} (${event.invoice.status ?? 'issued'})`,
      ];
    default:
      return [];
  }
}

function safeParseJson(text: string): WebhookResponseBody | null {
  try {
    return JSON.parse(text) as WebhookResponseBody;
  } catch {
    return null;
  }
}

function readOperationId(body: WebhookResponseBody | null): string | null {
  return body?.operationId ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { isoNow, newEventId };
