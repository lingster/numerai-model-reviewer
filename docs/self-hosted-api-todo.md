# TODO — Self-hosted Numerai API

Companion to [`self-hosted-api-prd.md`](./self-hosted-api-prd.md). Ordered so each step is
verifiable before the next depends on it. Branch: `feat/self-hosted-api`.

Prerequisite: access to the target server (10.13.1.10), the Cloudflare account, and the Numerai
API keys (same values as the worker's `wrangler secret` entries).

---

## 0. Run what already exists  ·  ~30 min

- [ ] `cd server && npm ci && npm test` — 40 tests should pass (CI runs this too).
- [ ] `npm start` with `ALLOWED_ORIGINS=http://localhost:5173`, then
      `curl -H 'Origin: http://localhost:5173' localhost:8787/health`.
- [ ] `cp server/.env.example server/.env`, fill the Numerai keys, then
      `cd server && docker compose up -d --build api` and check
      `docker compose ps` shows healthy.

**Done when:** the containerised API answers `/health` and `/rankings/cache-status` on the box.

---

## 1. Get the data onto the box  ·  ~1–2 h

The database is a cache, so there are two routes. Prefer the export; the rebuild takes days
through the Numerai API.

- [ ] Export from D1 (needs read quota — it resets at 00:00 UTC):
      `cd worker && npx wrangler d1 export numerai-cache --remote --output /tmp/d1-dump.sql`
- [ ] Import: `sqlite3 /var/lib/numerai/numerai-cache.sqlite < /tmp/d1-dump.sql`
- [ ] Apply the round index, which the dump will not contain if D1 never got it:
      `sqlite3 … < worker/migrations/0001_perf_tournament_round_index.sql`
      On local disk this is fast and free, unlike on D1.
- [ ] Point the container at it (bind-mount the file's directory as `/data`) and confirm
      `/rankings/cache-status?tournament=8` returns real round numbers rather than nulls.

**Done when:** `cache-status` reports the same spans D1 does (Classic `168–1334`, Signals
`232–1353`, Crypto `741–1353` as of 2026-09-19).

**Watch for:** the export may exceed the 5M daily read limit. If it fails part-way, wait for
midnight UTC rather than retrying immediately.

---

## 2. Make precompute write to SQLite  ·  ~1 day  ← the main piece

Today it writes through the `wrangler` CLI, which only talks to D1. Two seams, both small:

- [ ] **`D1Query` for SQLite.** `worker/src/wrangler-d1.ts` exports `createWranglerQuery`, which
      returns a `D1Query` (`worker/src/d1-query.ts`: `(sql) => rows`). Add the SQLite
      equivalent — `bindingQuery` in `d1-query.ts` already does exactly this over a
      `D1Database`, so `bindingQuery(sqliteD1.asD1())` may be all that is needed.
- [ ] **Batched writes.** `storeInD1` (`worker/src/precompute.ts:1146`) has an internal
      `execD1` that writes a temp `.sql` file and shells out to wrangler. Give it an injectable
      writer so it can execute statements against SQLite directly instead.
- [ ] **Select the target.** A `--sqlite <path>` flag (or `DATABASE_PATH`) alongside the
      existing `--local` / `--remote`, defaulting to current behaviour so the GitHub Actions
      workflow is unaffected while both run in parallel.
- [ ] Tests: the existing `worker/src/*.test.ts` suite must stay green, and add coverage that a
      run against a SQLite file writes `model_performances`, `tournament_coverage` and
      `round_field_metrics`.

**Done when:** `npx tsx src/precompute.ts --tournament 12 --top-n 3 --sqlite /tmp/t.sqlite
--no-cache` completes and Step 6 and Step 7 both report rows written.

**Watch for:** writes are much faster without the CLI round-trip; the batching that exists to
dodge wrangler's per-invocation overhead can be simplified, but do it in a separate commit.

---

## 3. Schedule precompute on the box  ·  ~2 h

- [ ] systemd timer (or cron) running the precompute daily, after Numerai resolves (~04:00 UTC).
- [ ] Log to a file with rotation; non-zero exit should be visible (mail, healthchecks.io, or
      whatever you already use).
- [ ] Keep `--backfill-rounds`; without the D1 write ceiling it can be raised well above 100 —
      try 500 and watch the wall-clock time.

**Done when:** two consecutive nights run unattended, and `round_field_metrics` grows.

---

## 4. Publish it  ·  ~1 h

- [ ] Create a Cloudflare Tunnel, put the token in `server/.env`, bring up the `tunnel` service
      in `docker-compose.yml`.
- [ ] Point a public hostname (e.g. `api.numerdiff.imperialai.ai`) at `http://api:8787`.
- [ ] Add that hostname to `ALLOWED_ORIGINS` handling — specifically, add the *frontend* origin
      to the API's allowlist; the API hostname itself is not an origin.
- [ ] Verify from outside the LAN: `curl -H 'Origin: https://numerdiff.imperialai.ai' https://api.…/health`.

**Done when:** the API answers over the public hostname and rejects unknown origins with 403.

---

## 5. Cut the frontend over  ·  ~1 h

- [ ] Set `VITE_API_URL` to the new hostname in the Pages project (`src/lib/config.ts:13` reads
      it; production currently falls back to `https://numerdiff-api.imperialai.ai`).
- [ ] Deploy a preview first and click through: models page, rankings, round summary.
- [ ] Compare ranks against the Cloudflare-backed API for the same model and round range. They
      must match exactly.

**Done when:** production traffic is served by the box and the pages behave identically.

---

## 6. Operations  ·  ~half a day

- [ ] **Backups.** Nightly `sqlite3 … ".backup"` (safe with WAL) to a second disk or offsite;
      keep 7 daily. Test a restore into a scratch container.
- [ ] **Monitoring.** Alert on: container unhealthy, precompute exit code, disk free, and
      `cache-status.latestRound` falling more than two rounds behind Numerai's current round.
- [ ] **Updates.** `docker compose build --pull && docker compose up -d` after merges to `main`.
- [ ] Decide the fate of the Cloudflare deployment: leaving the Worker and D1 in place is a
      free fallback, but D1 stays full — either prune it or accept it is read-only until then.

---

## 7. Follow-ups worth doing once it is stable

- [ ] Raise `--backfill-rounds` until history is fully covered; unmetered reads make this cheap.
- [ ] Revisit the windowed (20/60) ranking path, which still reads whole fields. Off D1 that is
      merely slow rather than expensive, so a simpler fix may now be acceptable.
- [ ] Consider dropping `graphql_cache` and the D1-era batching complexity in precompute.
- [ ] Move SQLite reads off the main thread **if latency warrants it**. `node:sqlite` is
      synchronous, so a slow query blocks every other in-flight request. Indexed queries here run
      in well under a millisecond and the load is one household, so measure before building
      anything: a worker-thread pool behind the `SqliteD1` shape is the fix, and it is not free.

---

## Conventions to preserve

- **Business logic lives in `worker/src`.** `server/src` holds only the bridge, the adapter and
  configuration. If you find yourself writing ranking or Numerai logic under `server/`, stop:
  that is the drift the shared-handler design exists to prevent.
- Tests before fixes, and prove a regression test fails against the bug.
- `schema.sql` must stay cheap to re-run; expensive or destructive changes go in `migrations/`.
  `worker/src/schema-safety.test.ts` enforces this.
