import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Every webhook delivery carries its own event id. WeAreDA deduplicates on it,
 * so a NEW state transition must always get a NEW id, while a RETRY of the same
 * delivery must reuse the id it was created with.
 */
export function newEventId(): string {
  return `evt_${randomBytes(16).toString('hex')}`;
}

/** Correlation id used in the local request/event log. */
export function newTraceId(): string {
  return randomUUID();
}

/** RFC3339 / ISO-8601 UTC timestamp with second precision, e.g. 2026-08-25T12:00:00Z */
export function isoTimestamp(date: Date = new Date()): string {
  return `${date.toISOString().split('.')[0]}Z`;
}

/** Milliseconds-precision ISO timestamp used for local log records. */
export function isoNow(): string {
  return new Date().toISOString();
}
