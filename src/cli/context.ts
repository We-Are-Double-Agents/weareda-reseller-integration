/**
 * Shared wiring for every CLI command.
 *
 * The CLI opens the SAME SQLite file the server uses (WAL mode, so both can run
 * at once). That is what lets `npm run cli -- stock P-1001 37` change the stock
 * that a running `GET /products` then reports.
 */
import { loadConfig, publicBaseUrl, type AppConfig } from '../config/env.js';
import { openDatabase, type Database } from '../storage/db.js';
import { EventLog } from '../services/event-log.js';
import { OrderService } from '../services/order-service.js';
import { ProductService } from '../services/product-service.js';
import { WeAreDAWebhookClient } from '../weareda/webhook-client.js';
import { WeAreDAResellerApiClient } from '../weareda/reseller-api-client.js';
import { setLogLevel } from '../lib/logger.js';

export interface CliContext {
  config: AppConfig;
  db: Database;
  products: ProductService;
  orders: OrderService;
  eventLog: EventLog;
  webhook: WeAreDAWebhookClient;
  readApi: WeAreDAResellerApiClient;
  publicBaseUrl: string;
  close(): void;
}

export function createContext(): CliContext {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const db = openDatabase(config.databasePath);
  const eventLog = new EventLog(db);
  const products = new ProductService(db);
  const orders = new OrderService(db);

  return {
    config,
    db,
    products,
    orders,
    eventLog,
    webhook: new WeAreDAWebhookClient(config, eventLog),
    readApi: new WeAreDAResellerApiClient(config),
    publicBaseUrl: publicBaseUrl(config),
    close: () => db.close(),
  };
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (name.includes('=')) {
      const [key, ...rest] = name.split('=');
      flags[key as string] = rest.join('=');
    } else if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { positionals, flags };
}
