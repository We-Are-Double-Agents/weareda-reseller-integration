/**
 * SQLite storage using the Node.js built-in `node:sqlite` module.
 *
 * Why SQLite: the sandbox can be restarted without losing received orders or
 * the event history. Why the built-in module: zero native dependencies, so
 * `npm install` never has to compile anything.
 *
 * Requires Node >= 22.5. Run with `--disable-warning=ExperimentalWarning` to
 * silence the experimental notice (all npm scripts already do).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Database = DatabaseSync;

const SCHEMA = `
-- Orders as this reseller stores them.
--
-- Note what is NOT here: an id supplied by WeAreDA. Per contract 4.3 the
-- delivered order payload carries no external order id - WeAreDA identifies the
-- order by order_number + idempotency_key, and adopts OUR id (SO-10001)
-- as its external_order_id from the POST /orders response body.
CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,          -- reseller order id, e.g. SO-10001
  order_number        TEXT,                      -- WeAreDA order number, e.g. ORD-1042
  idempotency_key     TEXT,                      -- e.g. order:6b1e...
  idempotency_suffix  TEXT,                      -- 6b1e... (shared with order-cancel:6b1e...)
  status              TEXT NOT NULL,             -- received | cancelled
  currency            TEXT,
  total               INTEGER,
  payload             TEXT NOT NULL,             -- raw order payload as delivered
  received_at         TEXT NOT NULL,
  cancelled_at        TEXT,
  cancellation_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_number     ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_idem       ON orders(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_idem_sfx   ON orders(idempotency_suffix);

-- Idempotency records. Scope separates order creation from cancellation so the
-- same key may legitimately appear in both flows.
CREATE TABLE IF NOT EXISTS idempotency_records (
  scope          TEXT NOT NULL,                  -- 'order' | 'cancel'
  key            TEXT NOT NULL,
  order_id       TEXT,
  status_code    INTEGER NOT NULL,
  response_body  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Stock owned by the reseller (this system). Seeded from data/products.json and
-- only ever changed by an EXPLICIT ERP simulation - never by an order.
CREATE TABLE IF NOT EXISTS stock_levels (
  entity_type TEXT NOT NULL,                     -- 'product' | 'variant'
  entity_id   TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- History of inbound calls (WeAreDA -> Reseller).
CREATE TABLE IF NOT EXISTS inbound_requests (
  id              TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  idempotency_key TEXT,
  status_code     INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  request_body    TEXT,
  response_body   TEXT,
  note            TEXT
);

-- History of outbound webhooks (Reseller -> WeAreDA). No secrets, no signatures.
CREATE TABLE IF NOT EXISTS outbound_events (
  id            TEXT PRIMARY KEY,                -- the X-WeAreDA-Event-Id we sent
  event_type    TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  attempts      INTEGER NOT NULL,
  status_code   INTEGER,
  operation_id  TEXT,
  deduped       INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  payload       TEXT NOT NULL,
  response_body TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

export function openDatabase(path: string): Database {
  const isMemory = path === ':memory:';
  const location = isMemory ? ':memory:' : resolve(process.cwd(), path);
  if (!isMemory) mkdirSync(dirname(location), { recursive: true });

  const db = new DatabaseSync(location);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Monotonic counter used for reseller order ids (SO-10001, SO-10002, ...).
 * `nextValue` is the first value handed out on a fresh database.
 */
export function nextCounter(db: Database, name: string, firstValue: number): number {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as
    { value: number } | undefined;
  const next = row ? row.value + 1 : firstValue;
  db.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
  ).run(name, next);
  return next;
}
