# The self-hosted Numerai API.
#
# The image carries two source trees: worker/ (the request handler and all the
# business logic, shared with the Cloudflare deployment) and server/ (the Node
# bridge and the SQLite adapter). The worker's runtime has no npm dependencies,
# so the only install is the server's — tsx, to run TypeScript directly.
#
# Build from the repository root so both trees are in context:
#   docker build -f server/Dockerfile -t numerai-api .

# Node 24 has node:sqlite stable; 22.13+ also works.
FROM node:24-alpine

# tini reaps zombies and forwards SIGTERM, so shutdown drains cleanly.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first: this layer is cached unless the manifests change.
COPY server/package.json server/package-lock.json ./server/
# ci, not install: the lockfile pins tsx so startup never reaches the network.
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# Sources. worker/ supplies the handler; server/ the bridge.
COPY worker/src ./worker/src
COPY worker/migrations ./worker/migrations
COPY worker/worker-configuration.d.ts ./worker/
COPY server/src ./server/src
COPY server/tsconfig.json ./server/

WORKDIR /app/server

# The database lives on a volume, not in the image.
ENV DATABASE_PATH=/data/numerai-cache.sqlite \
    SCHEMA_PATH=/app/worker/src/schema.sql \
    MIGRATIONS_PATH=/app/worker/migrations \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787

# Same endpoint the Cloudflare deploy smoke-tests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

RUN addgroup -S numerai && adduser -S numerai -G numerai && mkdir -p /data && chown numerai:numerai /data
USER numerai

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/server.ts"]
