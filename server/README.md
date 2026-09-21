# Self-hosted Numerai API

Runs the Cloudflare Worker's own request handler on Node, over a local SQLite file, so the API
has no metered row reads, row writes or database-size ceiling.

This is a bridge, not a second implementation. `worker/src/index.ts` exports a standard
`fetch(request, env, ctx)`; `src/server.ts` turns Node's HTTP requests into `Request` objects,
calls it, and writes the `Response` back. Routing, CORS, rate limiting, ranking and the Numerai
integration are the same code that runs on Cloudflare.

See [`../docs/self-hosted-api-prd.md`](../docs/self-hosted-api-prd.md) for the rationale and
[`../docs/self-hosted-api-todo.md`](../docs/self-hosted-api-todo.md) for the remaining work.

## Run it

```bash
npm ci
npm test                      # 23 tests

ALLOWED_ORIGINS=http://localhost:5173 npm start
curl -H 'Origin: http://localhost:5173' localhost:8787/health
```

## Run it in Docker

```bash
cp .env.example .env          # add the Numerai keys
docker compose up -d --build api
docker compose ps             # healthy
```

Build from the repository root, since the image needs both source trees:

```bash
docker build -f server/Dockerfile -t numerai-api .
```

The bundled `tunnel` service publishes the API on a hostname via Cloudflare Tunnel without
opening a router port. Remove it if you terminate TLS another way.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | |
| `DATABASE_PATH` | `./data/numerai-cache.sqlite` | The SQLite file; a volume in Docker |
| `SCHEMA_PATH` | `../worker/src/schema.sql` | Applied at startup |
| `MIGRATIONS_PATH` | `../worker/migrations` | Applied after the schema, in filename order |
| `APPLY_SCHEMA` | `true` | `false` to skip startup DDL |
| `NUMERAI_API_URL` | Numerai's GraphQL endpoint | |
| `NUMERAI_PUBLIC_KEY` / `NUMERAI_SECRET_KEY` | — | Warns if unset; stored-data endpoints still work |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated exact origins |
| `ALLOWED_ORIGIN_SUFFIXES` | — | e.g. `.pages.dev` for preview deployments |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` | `100` / `60` | In-memory here (no KV) |

## Notes

**Migrations run at startup**, unlike on Cloudflare where they are deliberately manual: building
an index on D1 writes a row per table row and can blow a daily quota, which on local disk is not
a concern. A fresh database therefore gets the `(tournament, round_number)` index immediately —
the one D1's free plan could not afford.

**The database is a cache** derived from the Numerai API. Back it up, but losing it means a
rebuild, not data loss.

**Keep logic out of this package.** Anything about ranking, scoring or Numerai belongs in
`worker/src` so both deployments share it.
