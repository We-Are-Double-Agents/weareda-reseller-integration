/**
 * Entry point for the local sandbox.
 *
 *   npm run dev     - watch mode
 *   npm start       - compiled build
 *   docker compose up
 */
import { loadConfig, publicBaseUrl } from './config/env.js';
import { buildServer } from './server.js';
import { banner, log, mask } from './lib/logger.js';
import { describeInboundAuth } from './middleware/auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const sandbox = buildServer(config);

  await sandbox.app.listen({ port: config.port, host: config.host });

  const base = publicBaseUrl(config);
  const isTunnelled = Boolean(config.publicBaseUrl);

  banner([
    'WeAreDA Reseller Sandbox',
    '',
    'This process is the RESELLER side of the integration.',
    'It implements what WeAreDA calls (WeAreDA -> Reseller) and',
    'it can call the WeAreDA webhook itself (Reseller -> WeAreDA).',
    '',
    'Local URL:',
    `http://localhost:${config.port}`,
    '',
    isTunnelled ? 'Public URL:' : 'Public URL:',
    isTunnelled ? config.publicBaseUrl : '(none - run `npm run tunnel` so WeAreDA can reach you)',
    '',
    'Use this as your WeAreDA baseUrl:',
    base,
    '',
    'WeAreDA -> Reseller (implemented here):',
    `GET  ${base}/`,
    `GET  ${base}/products`,
    `POST ${base}/orders`,
    `POST ${base}/orders/{externalOrderId}/cancel`,
    `POST ${base}/orders/cancel`,
    '',
    'Inbound auth (WeAreDA -> Reseller):',
    describeInboundAuth(config),
    `RESELLER_API_KEY = ${mask(config.inbound.apiKey)}`,
    '',
    'Reseller -> WeAreDA (outbound webhook):',
    config.webhook.url
      ? `POST ${config.webhook.url}`
      : 'WEAREDA_WEBHOOK_URL not set - CLI and scenarios run in DRY RUN mode',
    `WEAREDA_WEBHOOK_SECRET = ${mask(config.webhook.secret)}`,
    '',
    config.enableDebugEndpoints
      ? `Inspection: GET ${base}/debug/orders | /debug/products | /debug/events`
      : 'Inspection endpoints disabled (ENABLE_DEBUG_ENDPOINTS=false)',
    '',
    'Reminder: orders and stock are independent flows.',
    'Receiving or cancelling an order never changes stock here.',
    'Simulate an ERP inventory change explicitly:  npm run cli -- stock P-1001 37',
  ]);

  const shutdown = async (signal: string) => {
    log.info(`\nReceived ${signal}, shutting down.`);
    await sandbox.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start the sandbox:', error);
  process.exit(1);
});
