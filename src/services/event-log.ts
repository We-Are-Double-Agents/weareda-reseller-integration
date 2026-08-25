/**
 * Local history of everything that crossed the integration boundary.
 *
 * Stored so you can answer "what actually happened during that test?" after the
 * fact. Credentials, signatures and HMAC secrets are never written here - only
 * ids, statuses, timings and payloads.
 */
import type { Database } from '../storage/db.js';
import { isoNow, newTraceId } from '../lib/ids.js';

export interface InboundRecord {
  id: string;
  received_at: string;
  method: string;
  path: string;
  idempotency_key: string | null;
  status_code: number;
  duration_ms: number;
  request_body: unknown;
  response_body: unknown;
  note: string | null;
}

export interface OutboundRecord {
  id: string;
  event_type: string;
  sent_at: string;
  timestamp: string;
  attempts: number;
  status_code: number | null;
  operation_id: string | null;
  deduped: boolean;
  error: string | null;
  dry_run: boolean;
  payload: unknown;
  response_body: unknown;
}

export class EventLog {
  constructor(private readonly db: Database) {}

  recordInbound(entry: {
    method: string;
    path: string;
    idempotencyKey?: string | null;
    statusCode: number;
    durationMs: number;
    requestBody?: unknown;
    responseBody?: unknown;
    note?: string | null;
  }): string {
    const id = newTraceId();
    this.db
      .prepare(
        `INSERT INTO inbound_requests
           (id, received_at, method, path, idempotency_key, status_code, duration_ms, request_body, response_body, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        isoNow(),
        entry.method,
        entry.path,
        entry.idempotencyKey ?? null,
        entry.statusCode,
        Math.round(entry.durationMs),
        entry.requestBody === undefined ? null : JSON.stringify(entry.requestBody),
        entry.responseBody === undefined ? null : JSON.stringify(entry.responseBody),
        entry.note ?? null,
      );
    return id;
  }

  recordOutbound(entry: {
    eventId: string;
    eventType: string;
    timestamp: string;
    attempts: number;
    statusCode?: number | null;
    operationId?: string | null;
    deduped?: boolean;
    error?: string | null;
    dryRun?: boolean;
    payload: unknown;
    responseBody?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO outbound_events
           (id, event_type, sent_at, timestamp, attempts, status_code, operation_id, deduped, error, dry_run, payload, response_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempts = excluded.attempts,
           status_code = excluded.status_code,
           operation_id = excluded.operation_id,
           deduped = excluded.deduped,
           error = excluded.error,
           response_body = excluded.response_body`,
      )
      .run(
        entry.eventId,
        entry.eventType,
        isoNow(),
        entry.timestamp,
        entry.attempts,
        entry.statusCode ?? null,
        entry.operationId ?? null,
        entry.deduped ? 1 : 0,
        entry.error ?? null,
        entry.dryRun ? 1 : 0,
        JSON.stringify(entry.payload),
        entry.responseBody === undefined ? null : JSON.stringify(entry.responseBody),
      );
  }

  inbound(limit = 100): InboundRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM inbound_requests ORDER BY received_at DESC LIMIT ?')
      .all(limit) as unknown as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.id,
      received_at: row.received_at,
      method: row.method,
      path: row.path,
      idempotency_key: row.idempotency_key,
      status_code: row.status_code,
      duration_ms: row.duration_ms,
      request_body: parse(row.request_body),
      response_body: parse(row.response_body),
      note: row.note,
    }));
  }

  outbound(limit = 100): OutboundRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM outbound_events ORDER BY sent_at DESC LIMIT ?')
      .all(limit) as unknown as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      sent_at: row.sent_at,
      timestamp: row.timestamp,
      attempts: row.attempts,
      status_code: row.status_code,
      operation_id: row.operation_id,
      deduped: Boolean(row.deduped),
      error: row.error,
      dry_run: Boolean(row.dry_run),
      payload: parse(row.payload),
      response_body: parse(row.response_body),
    }));
  }
}

function parse(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
