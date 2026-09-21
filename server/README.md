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
cp .env.example .env          # optional; see Configuration
docker compose up -d --build api
docker compose ps             # healthy
```

Build from the repository root, since the image needs both source trees:

```bash
docker build -f server/Dockerfile -t numerai-api .
```

The API port is bound to `127.0.0.1` only. To publish it, either route a hostname to
`http://127.0.0.1:8787` from a `cloudflared` already running on the host, or use the bundled
opt-in `tunnel` service: `docker compose --profile tunnel up -d`, with `TUNNEL_TOKEN` in `.env`.

The container runs with a read-only root filesystem, no capabilities and `no-new-privileges`;
only `/data` and a `/tmp` tmpfs are writable. For a host directory owned by a dedicated user:

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin numerdiff
sudo install -d -o numerdiff -g numerdiff -m 750 /data/numerai/numerdiff
# .env: DATA_DIR=/data/numerai/numerdiff, APP_UID/APP_GID from `id numerdiff`
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | |
| `DATABASE_PATH` | `./data/numerai-cache.sqlite` | The SQLite file; `/data/…` in Docker |
| `DATA_DIR` | named volume | Compose only: host directory mounted at `/data` |
| `APP_UID` / `APP_GID` | image's `numerai` user | Compose only: must own `DATA_DIR` |
| `SCHEMA_PATH` | `../worker/src/schema.sql` | Applied at startup |
| `MIGRATIONS_PATH` | `../worker/migrations` | Applied after the schema, in filename order |
| `APPLY_SCHEMA` | `true` | `false` to skip startup DDL |
| `NUMERAI_API_URL` | Numerai's GraphQL endpoint | |
| `NUMERAI_PUBLIC_KEY` / `NUMERAI_SECRET_KEY` | — | Optional; sent only when both are set. Queries are public data |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated exact origins |
| `ALLOWED_ORIGIN_SUFFIXES` | — | e.g. `.pages.dev` for preview deployments |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` | `100` / `60` | In-memory here (no KV) |
| `MAX_REQUEST_BODY_BYTES` | `1048576` | Bodies over this get 413. Every route is a GET |

Numeric variables are validated at startup: a non-integer, a negative or (for the rate limit) a
zero is a startup failure rather than a silently wrong setting.

## Notes

**Migrations run at startup**, unlike on Cloudflare where they are deliberately manual: building
an index on D1 writes a row per table row and can blow a daily quota, which on local disk is not
a concern. A fresh database therefore gets the `(tournament, round_number)` index immediately —
the one D1's free plan could not afford. Each migration is applied once, in its own transaction,
and recorded in `applied_migrations`; `schema.sql` is re-applied every start, which is safe
because it is written to be (`worker/src/schema-safety.test.ts`).

**SQLite calls block the event loop.** `node:sqlite` is synchronous, so a slow query stalls every
other in-flight request. With the round index in place the API's queries are sub-millisecond and
one box serves one household, so this is not a problem today — but it is the first thing to look
at if latency becomes one. Fixes, in order of cost: keep the indexes healthy, then move reads to
a worker thread pool behind the same `D1Database` shape.

**The database is a cache** derived from the Numerai API. Back it up, but losing it means a
rebuild, not data loss.

**Keep logic out of this package.** Anything about ranking, scoring or Numerai belongs in
`worker/src` so both deployments share it.
