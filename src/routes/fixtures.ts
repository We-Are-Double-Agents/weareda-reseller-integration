/**
 * Serves the demo invoice PDF.
 *
 * Contract 6.3: a `document_url` on an invoice.issued event must serve a PDF
 * over HTTPS and be reachable by WeAreDA, which fetches and stores a copy. The
 * host also has to be allow-listed via `sync_config.documentHosts`.
 *
 * Locally that means: run `npm run tunnel`, set PUBLIC_BASE_URL to the tunnel
 * URL, and the invoice event will point at
 *   https://<tunnel-host>/fixtures/invoices/demo.pdf
 * which WeAreDA can actually fetch. Deliberately unauthenticated - WeAreDA
 * fetches document URLs without your connector credentials.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

const FIXTURE_DIR = resolve(process.cwd(), 'fixtures/invoices');

export function registerFixtureRoutes(app: FastifyInstance): void {
  app.get<{ Params: { '*': string } }>('/fixtures/invoices/*', async (request, reply) => {
    // basename() keeps the path traversal-safe: only files directly inside
    // fixtures/invoices can ever be served.
    const requested = basename(request.params['*'] ?? '');
    if (!requested.toLowerCase().endsWith('.pdf')) {
      return reply.code(404).send({ error: 'not_found', message: 'Only PDF fixtures are served.' });
    }

    const path = resolve(FIXTURE_DIR, requested);
    if (!path.startsWith(FIXTURE_DIR) || !existsSync(path)) {
      return reply.code(404).send({ error: 'not_found', message: `No fixture named ${requested}` });
    }

    return reply
      .header('content-type', 'application/pdf')
      .header('content-length', statSync(path).size)
      .header('content-disposition', `inline; filename="${requested}"`)
      .send(createReadStream(path));
  });
}
