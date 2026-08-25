# ---------------------------------------------------------------------------
# WeAreDA reseller reference implementation
#
# Docker is OPTIONAL. `npm run dev` remains the primary workflow; this image
# exists so `docker compose up` gives you the identical sandbox.
# ---------------------------------------------------------------------------

# Node 22.5+ is required for the built-in node:sqlite module.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Catalog fixtures and the demo invoice PDF are runtime data, not build inputs.
COPY data ./data
COPY fixtures ./fixtures

# SQLite lives on a volume so orders and event history survive a restart.
RUN mkdir -p /app/var && chown -R node:node /app/var
VOLUME ["/app/var"]

USER node
EXPOSE 3000

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=var/sandbox.db

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
