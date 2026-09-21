# PRD — Self-hosted Numerai API

**Status:** foundation built and verified locally; remaining work assigned.
**Owner:** unassigned (needs access to the target server, 10.13.1.10)
**Branch:** `feat/self-hosted-api`

## Why

The app's rankings data outgrew Cloudflare D1's free plan, and on 2026-09-01 Cloudflare
[began enforcing](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
the free-tier daily limits that had previously been advisory. Two ceilings now bite:

| Limit | Free plan | Ours |
|---|---|---|
| Rows read | 5M / day | 27.1M on 2026-09-21, 18.8M on 09-17 |
| Rows written | 100k / day | ~57k/day normally |
| Database size | per-database cap | **757 MB — over it; all writes fail** |

The database has been full since 2026-09-19. Every precompute run since has failed, so the
data is stale and the per-round field optimisation (PR #7) — which would cut reads by orders
of magnitude — can never write its rows. The two faults reinforce each other.

Reads are the structural problem. Ranking a model in a round requires knowing how many models
scored above it, so the live path reads every staked model's row for every round: ~4,600 rows
per round, ~300,000 for the default 30-round view of one model, once per model compared.

Self-hosting removes metered rows entirely. The same queries against a local SQLite file are
unmetered and sub-millisecond, and the storage ceiling becomes the disk.

## Goals

1. Serve the existing API from our own server with no behaviour change for the frontend.
2. Remove the D1 read/write/size ceilings as a class of problem.
3. Keep **one** implementation of the API. No forked business logic.
4. Deploy with `docker compose up`, reproducibly.

## Non-goals

- Rewriting the frontend. It keeps talking to the same REST contract at a different hostname.
- Changing rankings semantics or the Numerai integration.
- Migrating the frontend off Cloudflare Pages. Pages is free, fast and fine.
- Multi-node or HA. One box is the brief.

## Approach, and why

**The self-hosted server runs the worker's own `fetch` handler.** `worker/src/index.ts` is a
plain `fetch(request, env, ctx)` over web-standard `Request`/`Response`, which Node has had
since v18. `server/src/server.ts` is therefore a *bridge*, not a port: `node:http` in, `Request`
out, `Response` back. Routing, CORS, rate limiting, ranking and the Numerai calls are the exact
code that runs on Cloudflare today.

The alternative — reimplementing the endpoints against SQLite — was rejected: two
implementations of the same API drift, and the ranking logic is subtle enough (tie handling,
Float64 precision, staked-field membership, the windowed fallbacks) that divergence would be
silent and wrong rather than loud.

**D1 is SQLite**, so no query needed translating. `server/src/sqlite-d1.ts` implements the
binding's *shape* — `prepare/bind`, `first/all/run/raw`, `batch` — over `node:sqlite`. That is
the only genuinely new code, and it is the thing most covered by tests.

**Migrations are applied at startup.** On Cloudflare they are deliberately manual, because
building an index on D1 writes one row per table row and can exceed a daily quota. On our own
disk that cost does not exist, so a self-hosted database gets the good
`(tournament, round_number)` index from the start — the one the free plan could not afford, and
which the rankings queries want.

## Architecture

```
today                               target
─────                               ──────
Pages (frontend)                    Pages (frontend)          unchanged
      │                                   │
      ▼                                   ▼
Cloudflare Worker                   Cloudflare Tunnel ──▶ Docker: numerai-api
      │                                                         │
      ▼                                                    SQLite volume
Cloudflare D1  ◀── precompute (GitHub Actions, wrangler CLI)     ▲
                                                                 │
                                          precompute (cron on the box, direct writes)
```

The Worker can't reach `10.13.1.10` — it runs at the edge and the address is private. A
Cloudflare Tunnel gives the box a public hostname without opening a port on the router, and the
frontend's `VITE_API_URL` points at it.

## Already built on this branch

Verified locally, including in Docker:

- `server/src/sqlite-d1.ts` — the D1-shaped SQLite adapter (12 tests).
- `server/src/server.ts` — the node:http ↔ worker-handler bridge, with a request-body cap so an
  unauthenticated client cannot make it buffer unbounded memory ahead of routing.
- `server/src/config.ts` — environment configuration mirroring the worker's vars, validated at
  startup rather than coerced.
- `server/src/migrations.ts` — schema application and once-only, transactional migrations.
- `server/Dockerfile`, `server/docker-compose.yml`, `server/.env.example` — image builds
  (165 MB), starts with **no network access**, and reports healthy.

Proven working against the running server: `/health`, `/rankings/cache-status`, CORS allow and
deny, preflight, 404s, parameter validation, and a **live Numerai call returning 1,192 rounds
with 375 MMC60 values and the `3xCORR60 + 15xMMC60` payout formula**.

## What remains

The detailed, ordered checklist is in [`self-hosted-api-todo.md`](./self-hosted-api-todo.md).
The substantial item is the precompute: it currently writes through the `wrangler` CLI and must
write to SQLite instead. The seams are already isolated — `createWranglerQuery` (a `D1Query`
implementation) and `storeInD1`'s internal `execD1` — so this is a new implementation of a small
interface, not a rewrite.

## Success criteria

1. The frontend works end to end against the self-hosted API, with the rankings page showing
   the same ranks as Cloudflare does for the same rounds.
2. A precompute run completes on the box and writes rounds, coverage **and** round fields.
3. The default 30-round rankings view is served from stored fields.
4. `docker compose up -d` on a clean checkout reaches healthy without manual steps beyond `.env`.
5. Nightly backups exist and a restore has been tested at least once.

## Risks

| Risk | Mitigation |
|---|---|
| The box or its connection goes down; the site goes with it | Tunnel + `restart: unless-stopped`; keep the Worker deployable as fallback (the code still runs on Cloudflare — that is the point of sharing the handler) |
| SQLite write locking during precompute | WAL is enabled, `busy_timeout` set to 10s; precompute writes in batched transactions |
| Data loss on the box | Database is a **cache** derived from the Numerai API and is rebuildable; still, back up the volume |
| Divergence between the two deployments creeping back | Keep the shared-handler rule: business logic lives in `worker/src`, never in `server/src` |
| Exposing the box | Tunnel only; API bound to `127.0.0.1` on the host; no router ports |

## Decisions taken

- **SQLite, not Postgres.** The data is single-writer, read-mostly, and already SQLite-shaped.
  Postgres would mean translating every query and losing the shared-handler property.
- **`tsx` at runtime rather than a compiled build.** Matches how precompute already runs, and
  avoids an output-extension rewrite step. It is a pinned dependency, not fetched at start.
- **Keep the Cloudflare Worker deployable.** It costs nothing to leave in place and is the
  fallback if the box is down.
