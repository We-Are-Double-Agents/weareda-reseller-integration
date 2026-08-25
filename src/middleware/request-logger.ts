/**
 * Prints, for every inbound call, a readable block that names the direction:
 *
 *   INCOMING REQUEST
 *   Direction: WeAreDA -> Reseller
 *   POST /orders
 *   ...
 *
 * and records the same information (minus credentials) in the local history so
 * `GET /debug/events` can show it later.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logInboundRequest } from '../lib/logger.js';
import type { EventLog } from '../services/event-log.js';

declare module 'fastify' {
  interface FastifyRequest {
    startedAt?: number;
    /** Free-form notes attached by a route and printed under "Notes:". */
    logNotes?: string[];
  }
}

export function registerRequestLogging(app: FastifyInstance, eventLog: EventLog): void {
  app.decorateRequest('startedAt', undefined);
  app.decorateRequest('logNotes', undefined);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.startedAt = performance.now();
    request.logNotes = [];
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // Binary responses (the invoice PDF) are logged without a body.
    const contentType = String(reply.getHeader('content-type') ?? '');
    const isJson = contentType.includes('application/json');
    const durationMs = performance.now() - (request.startedAt ?? performance.now());
    const responseBody = isJson && typeof payload === 'string' ? safeParse(payload) : undefined;
    const idempotencyKey = headerValue(request.headers['idempotency-key']);

    logInboundRequest({
      method: request.method,
      url: request.url,
      headers: request.headers as Record<string, unknown>,
      body: request.body,
      statusCode: reply.statusCode,
      responseBody: responseBody ?? `(${contentType || 'no content-type'})`,
      durationMs: Math.round(durationMs),
      notes: request.logNotes,
    });

    eventLog.recordInbound({
      method: request.method,
      path: request.url,
      idempotencyKey,
      statusCode: reply.statusCode,
      durationMs,
      requestBody: request.body,
      responseBody,
      note: request.logNotes?.length ? request.logNotes.join(' | ') : null,
    });

    return payload;
  });
}

export function addLogNote(request: FastifyRequest, note: string): void {
  request.logNotes = request.logNotes ?? [];
  request.logNotes.push(note);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
