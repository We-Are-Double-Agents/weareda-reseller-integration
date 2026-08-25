/**
 * `npm run scenario:catalog-push`
 *
 * Demonstrates BOTH catalog transports (contract 4.2 vs 6.5) using the SAME
 * serializer, and the two rules that differ between them:
 *
 *   pull  GET /products      complete catalog; a full pull can archive-missing
 *   push  product.updated    partial by nature; NEVER archives what you omit
 */
import { createScenarioContext, scenarioBanner, step, webhookModeNotice } from './harness.js';
import { buildProductUpdatedEvent } from '../weareda/events.js';
import { PRODUCT_BATCH_MAX_ITEMS } from '../weareda/types.js';
import { log } from '../lib/logger.js';

async function main(): Promise<void> {
  const ctx = await createScenarioContext();

  scenarioBanner('SCENARIO: catalog pull vs catalog push', [`Sandbox: ${ctx.baseUrl}`]);
  webhookModeNotice(ctx);

  /* -------------------------------------------------------------------- */
  step(1, 'PULL - WeAreDA -> Reseller: GET /products?page=1&limit=3');
  const firstPage = await ctx.callAsWeAreDA('GET', '/products?page=1&limit=3');
  log.plain(`Response: ${firstPage.status}`);
  log.plain(
    `page 1 returned ${firstPage.body.products.length} of ${firstPage.body.total} product(s): ` +
      firstPage.body.products.map((p: { id: string }) => p.id).join(', '),
  );
  log.plain('WeAreDA keeps asking for page=2,3,... until a page returns fewer than `limit` items.');

  const secondPage = await ctx.callAsWeAreDA('GET', '/products?page=2&limit=3');
  log.plain(
    `page 2 returned ${secondPage.body.products.length}: ` +
      secondPage.body.products.map((p: { id: string }) => p.id).join(', '),
  );

  /* -------------------------------------------------------------------- */
  step(2, 'PULL - incremental sync with updated_since');
  const incremental = await ctx.callAsWeAreDA(
    'GET',
    '/products?updated_since=2026-08-20T00:00:00Z',
  );
  log.plain(
    `${incremental.body.products.length} product(s) changed since 2026-08-20: ` +
      incremental.body.products.map((p: { id: string }) => p.id).join(', '),
  );
  log.plain('An incremental pull never archives anything (contract 4.2).');

  /* -------------------------------------------------------------------- */
  step(3, 'PUSH - Reseller -> WeAreDA: product.updated with the changed products');
  const changed = ['P-1001', 'P-1002'].map((id) => ctx.products.find(id)!);
  log.plain(`Pushing ${changed.length} product(s) - the exact objects GET /products returns.`);
  log.plain(`Batch cap: ${PRODUCT_BATCH_MAX_ITEMS} products and 512 KB per event.`);
  await ctx.webhook.send(buildProductUpdatedEvent(changed));

  /* -------------------------------------------------------------------- */
  step(4, 'PUSH - what a push does NOT mean');
  log.plain('That event named 2 products out of ' + ctx.products.all().length + ' in the catalog.');
  log.plain('The other products are NOT archived, NOT deleted, NOT touched.');
  log.plain('A push says "here is what changed", never "here is everything I have".');

  /* -------------------------------------------------------------------- */
  step(5, 'PUSH - retiring a product means sending status "archived"');
  const retired = { ...ctx.products.find('P-1004')!, status: 'archived' };
  log.plain(
    `Sending ${retired.id} with status "archived" - the only way to retire it in push mode.`,
  );
  await ctx.webhook.send(buildProductUpdatedEvent([retired]));

  scenarioBanner('SCENARIO COMPLETE', [
    'One serializer fed both transports.',
    '',
    'pull: complete catalog, paginated, can archive-missing on a full sync',
    'push: partial batches, never archives by omission, retire with',
    '      status: "archived"',
  ]);

  await ctx.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
