/**
 * Shared plumbing for the guided scenarios.
 *
 * A scenario drives BOTH directions of the integration:
 *   - it plays WeAreDA by calling this sandbox's inbound endpoints, and
 *   - it plays the reseller by sending signed webhooks back to WeAreDA.
 *
 * If a sandbox is already running on PORT it is reused (so you can watch the
 * request log in the other terminal); otherwise the scenario starts one
 * in-process on an ephemeral port.
 */
import { loadConfig, publicBaseUrl, type AppConfig } from '../config/env.js';
import { buildServer, type SandboxServer } from '../server.js';
import { WeAreDAWebhookClient } from '../weareda/webhook-client.js';
import { EventLog } from '../services/event-log.js';
import { openDatabase } from '../storage/db.js';
import { ProductService } from '../services/product-service.js';
import { OrderService } from '../services/order-service.js';
import { banner, log, RULE } from '../lib/logger.js';
import { mask } from '../lib/redact.js';

export interface ScenarioContext {
  config: AppConfig;
  /** Base URL of the sandbox the scenario is driving. */
  baseUrl: string;
  /** True when the scenario had to start its own server. */
  embedded: boolean;
  webhook: WeAreDAWebhookClient;
  products: ProductService;
  orders: OrderService;
  /** Calls the sandbox the way WeAreDA would, with the inbound credentials. */
  callAsWeAreDA(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; idempotencyKey?: string },
  ): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function createScenarioContext(): Promise<ScenarioContext> {
  const config = loadConfig();
  const externalBase = `http://localhost:${config.port}`;

  let server: SandboxServer | null = null;
  let baseUrl = externalBase;

  const alreadyRunning = await isUp(`${externalBase}/healthz`);

  if (alreadyRunning) {
    log.plain(`Using the sandbox already running at ${externalBase}.`);
  } else {
    log.plain(`No sandbox on ${externalBase} - starting one in-process for this scenario.`);
    server = buildServer(config);
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const address = server.app.server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  // The scenario reads local state directly from the same SQLite file.
  const db = openDatabase(config.databasePath);
  const eventLog = new EventLog(db);

  return {
    config,
    baseUrl,
    embedded: server !== null,
    webhook: new WeAreDAWebhookClient(config, eventLog),
    products: new ProductService(db, 'data/products.json', publicBaseUrl(config)),
    orders: new OrderService(db),
    async callAsWeAreDA(method, path, options = {}) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      applyInboundAuth(headers, config);
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    },
    async close() {
      db.close();
      if (server) await server.close();
    },
  };
}

/** Attaches the credentials WeAreDA would send, per the configured auth mode. */
function applyInboundAuth(headers: Record<string, string>, config: AppConfig): void {
  const { mode, apiKey, customHeader, basicUser, basicPassword } = config.inbound;
  switch (mode) {
    case 'api_key':
      headers['X-API-Key'] = apiKey;
      break;
    case 'bearer':
      headers.Authorization = `Bearer ${apiKey}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString('base64')}`;
      break;
    case 'custom':
      headers[customHeader] = apiKey;
      break;
    case 'none':
      break;
  }
}

async function isUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export function step(index: number, title: string): void {
  log.plain('');
  log.plain(RULE);
  log.plain(`STEP ${index} - ${title}`);
  log.plain(RULE);
}

export function scenarioBanner(title: string, lines: string[]): void {
  banner([title, '', ...lines]);
}

export function webhookModeNotice(ctx: ScenarioContext): void {
  if (ctx.webhook.configured) return;
  scenarioBanner('DRY RUN MODE', [
    'WEAREDA_WEBHOOK_URL / WEAREDA_WEBHOOK_SECRET are not set, so outbound',
    'events are signed and printed but not sent.',
    '',
    `WEAREDA_WEBHOOK_URL    = ${ctx.config.webhook.url || '(not set)'}`,
    `WEAREDA_WEBHOOK_SECRET = ${mask(ctx.config.webhook.secret)}`,
  ]);
}
