/**
 * Serves the sample files the sandbox references: invoice PDFs and product
 * images.
 *
 * Both exist for the same reason. WeAreDA fetches these URLs itself:
 *
 *   - an invoice `document_url` must serve a PDF over HTTPS (contract 6.3), and
 *     its host must be allow-listed via sync_config.documentHosts;
 *   - product `images` are URLs WeAreDA reads from your catalog (contract 4.2).
 *
 * A URL pointing at a host that does not exist cannot be tested. So the sandbox
 * hosts the samples itself: run `npm run tunnel`, set PUBLIC_BASE_URL to the
 * tunnel URL, and every fixture URL becomes an https address WeAreDA can
 * actually fetch.
 *
 * Deliberately unauthenticated - WeAreDA fetches these without your connector
 * credentials.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

const FIXTURE_ROOT = resolve(process.cwd(), 'fixtures');

/** Only these types are ever served, and only from the directory that owns them. */
const COLLECTIONS: Record<string, Record<string, string>> = {
  invoices: { '.pdf': 'application/pdf' },
  products: {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  },
};

export function registerFixtureRoutes(app: FastifyInstance): void {
  app.get<{ Params: { collection: string; '*': string } }>(
    '/fixtures/:collection/*',
    async (request, reply) => {
      const types = COLLECTIONS[request.params.collection];
      if (!types) {
        return reply.code(404).send({ error: 'not_found', message: 'Unknown fixture collection.' });
      }

      // basename() keeps this traversal-safe: only files directly inside the
      // collection directory can ever be served.
      const requested = basename(request.params['*'] ?? '');
      const contentType = types[extname(requested).toLowerCase()];
      if (!contentType) {
        return reply.code(404).send({
          error: 'not_found',
          message: `Only ${Object.keys(types).join(', ')} files are served from /fixtures/${request.params.collection}.`,
        });
      }

      const directory = resolve(FIXTURE_ROOT, request.params.collection);
      const path = resolve(directory, requested);
      if (!path.startsWith(`${directory}/`) || !existsSync(path)) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: `No fixture named ${requested}` });
      }

      return reply
        .header('content-type', contentType)
        .header('content-length', statSync(path).size)
        .header('cache-control', 'public, max-age=300')
        .header('content-disposition', `inline; filename="${requested}"`)
        .send(createReadStream(path));
    },
  );
}
