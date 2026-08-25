/**
 * Human-readable, direction-aware logging.
 *
 * Every log block states the direction of the HTTP call explicitly:
 *
 *   WeAreDA -> Reseller   inbound  (WeAreDA calls this server)
 *   Reseller -> WeAreDA   outbound (this server calls the WeAreDA webhook or read API)
 *
 * Getting the direction wrong is the root cause of most integration
 * confusion, so it is printed on every single request.
 */
import { mask, maskUrl, redactHeaders } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const RULE = '-'.repeat(50);
const HEAVY_RULE = '='.repeat(50);

let currentLevel: LogLevel = 'debug';

export function setLogLevel(level: string): void {
  const normalized = level.toLowerCase() as LogLevel;
  currentLevel = normalized in LEVELS ? normalized : 'debug';
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function write(level: LogLevel, line: string): void {
  if (!enabled(level)) return;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', `WARNING: ${msg}`),
  error: (msg: string) => write('error', `ERROR: ${msg}`),
  /** Prints a line without any level prefix (used by the CLI). */
  plain: (msg = '') => console.log(msg),
};

function pretty(value: unknown): string {
  if (value === undefined) return '(empty)';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface InboundLogRecord {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
  statusCode: number;
  responseBody: unknown;
  durationMs: number;
  notes?: string[];
}

/** WeAreDA -> Reseller */
export function logInboundRequest(record: InboundLogRecord): void {
  if (!enabled('info')) return;
  const headers = redactHeaders(record.headers);
  const interesting = Object.entries(headers).filter(([name]) =>
    [
      'x-api-key',
      'authorization',
      'idempotency-key',
      'content-type',
      'user-agent',
      'x-weareda-event-id',
      'x-request-id',
    ].includes(name.toLowerCase()),
  );

  const lines: string[] = [
    RULE,
    'INCOMING REQUEST',
    'Direction: WeAreDA -> Reseller',
    `${record.method} ${record.url}`,
    '',
    'Headers:',
    ...interesting.map(([name, value]) => `${name}: ${value}`),
  ];

  if (record.body !== undefined && record.body !== null && record.body !== '') {
    lines.push('', 'Body:', pretty(record.body));
  }

  lines.push('', 'Response:', String(record.statusCode), pretty(record.responseBody));

  if (record.notes?.length) {
    lines.push('', 'Notes:', ...record.notes);
  }

  lines.push(`(${record.durationMs}ms)`, RULE);
  console.log(lines.join('\n'));
}

export interface OutboundLogRecord {
  url: string;
  method: string;
  eventType: string;
  eventId: string;
  timestamp: string;
  summary?: string[];
  body?: string;
  attempt?: number;
  statusCode?: number;
  statusText?: string;
  responseBody?: unknown;
  operationId?: string | null;
  deduped?: boolean;
  error?: string;
  dryRun?: boolean;
}

/** Reseller -> WeAreDA */
export function logOutboundWebhook(record: OutboundLogRecord): void {
  if (!enabled('info')) return;
  const lines: string[] = [
    RULE,
    record.dryRun ? 'OUTGOING WEBHOOK (DRY RUN - NOT SENT)' : 'OUTGOING WEBHOOK',
    'Direction: Reseller -> WeAreDA',
    '',
    'Destination:',
    `${record.method} ${maskUrl(record.url)}`,
    '',
    'Event:',
    record.eventType,
    '',
    'Event ID:',
    record.eventId,
    '',
    'Timestamp:',
    record.timestamp,
  ];

  if (record.summary?.length) {
    lines.push('', ...record.summary);
  }

  if (record.body !== undefined && enabled('debug')) {
    lines.push('', 'Body:', pretty(record.body));
  }

  if (record.attempt && record.attempt > 1) {
    lines.push('', `Attempt: ${record.attempt}`);
  }

  if (record.error) {
    lines.push('', 'Response:', `FAILED: ${record.error}`);
  } else if (record.dryRun) {
    lines.push('', 'Response:', '(dry run - WEAREDA_WEBHOOK_URL is not configured)');
  } else {
    lines.push('', 'Response:', `${record.statusCode} ${record.statusText ?? ''}`.trim());
    if (record.operationId) lines.push('Operation ID:', record.operationId);
    if (record.deduped) lines.push('Deduped: true (WeAreDA had already processed this event id)');
    if (record.responseBody !== undefined) lines.push(pretty(record.responseBody));
  }

  lines.push(RULE);
  console.log(lines.join('\n'));
}

export function banner(lines: string[]): void {
  console.log([HEAVY_RULE, ...lines, HEAVY_RULE].join('\n'));
}

export { mask, HEAVY_RULE, RULE };
