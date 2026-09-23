-- Numerai Rankings Cache Schema
-- Used by the Cloudflare Worker to cache GraphQL responses and precomputed data

CREATE TABLE IF NOT EXISTS graphql_cache (
  cache_key TEXT PRIMARY KEY,
  response_data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400
);

CREATE TABLE IF NOT EXISTS top_staked_models (
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  username TEXT NOT NULL,
  stake_value REAL NOT NULL,
  tournament INTEGER NOT NULL DEFAULT 8,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model_name, tournament)
);

CREATE TABLE IF NOT EXISTS model_performances (
  model_name TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  -- Classic/Crypto scoring fields. For Signals these are populated by their
  -- v2RoundModelPerformances mappings (fncV4 / mmc20d).
  corr REAL,
  mmc REAL,
  tc REAL,
  -- Signals "new scoring" fields, sourced from submissionScores. Null for
  -- Classic/Crypto rows. Kept as separate columns rather than overloading
  -- corr/mmc so a single tournament=11 row carries both regimes.
  alpha REAL,
  mpc REAL,
  -- Signals' neutral pair (neutral correlation / neutral contribution), which
  -- Numerai pays on from rounds opening 2026-09-25. Same source, same rounds as
  -- alpha/mpc; see ranking.ts MetricSet. Added to existing DBs by migration 0005.
  neutral_corr REAL,
  neutral_mmc REAL,
  -- Classic's 60-day pair, what it is paid on since 28 Aug 2026 (3*CORR60 +
  -- 15*MMC60). corr60 comes from the profile query, mmc60 from submissionScores.
  corr60 REAL,
  mmc60 REAL,
  stake_value REAL,
  tournament INTEGER NOT NULL DEFAULT 8,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model_name, round_number, tournament)
);

-- Idempotent ALTER for databases created from the original schema (pre alpha/mpc).
-- D1 lacks IF NOT EXISTS on ADD COLUMN, so this is wrapped in a CI migration step
-- elsewhere. Safe to ignore the error if columns already exist.
-- ALTER TABLE model_performances ADD COLUMN alpha REAL;
-- ALTER TABLE model_performances ADD COLUMN mpc REAL;

-- This file is re-applied to the production D1 on every worker deploy
-- (deploy-worker.yml), so everything in it must be cheap to re-run: tables with
-- IF NOT EXISTS, and only indexes production already has. schema-safety.test.ts
-- enforces that.
--
-- The model_performances round index is therefore NOT declared here. It lives in
-- migrations/0001_perf_tournament_round_index.sql, because building an index on
-- the existing ~5M-row table writes ~5M rows, and the self-hosted server widens
-- it into a covering index in migrations/0003. A fresh database (CI, local dev,
-- tests, the self-hosted server) applies this file and then migrations/*.sql in
-- order.
-- No index on model_name: nothing queries model_performances by model name any
-- more (the rankings read paths all filter by tournament and round), and every
-- index costs an extra written row per stored performance row — ~10k a day
-- against a 100k/day free limit. migrations/0002 drops it from production.
CREATE INDEX IF NOT EXISTS idx_cache_ttl ON graphql_cache(created_at, ttl_seconds);

-- One row per tournament: the first and last round stored in model_performances.
-- /rankings/cache-status runs on every rankings page load and reads this row
-- instead of computing MIN/MAX(round_number) over the table, which on
-- production's (round_number, tournament) index read a large share of the
-- ~5M rows per call. Precompute replaces the row after each store; the worker
-- only reads it. See tournament-coverage.ts.
-- One row per round holding that round's whole field: every staked model's
-- scored metric pair, packed as base64 Float64 arrays (~96KB for 4,600 models).
-- Ranking a model in a round needs to know how many models scored above it, so
-- the live path reads every model's row for the round (~4,600) — ~300k reads for
-- the default 30-round view of one model. From here it is one read per round.
--
-- Metrics, not scores: the payout formula changes (Classic moved to 3xCORR60 +
-- 15xMMC60) and the UI varies the weights per request, so stored scores would
-- invalidate history. Model names are not stored; a model's own metrics come
-- from its own model_performances rows. See round-field.ts.
-- field_scope: which competitors the stored field holds — 'staked' (the staked
-- field, what payouts rank against) or 'all' (every model that scored, staked or
-- not). One row per round per scope; see round-field.ts.
CREATE TABLE IF NOT EXISTS round_field_metrics (
  tournament INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  field_scope TEXT NOT NULL DEFAULT 'staked',
  -- metric_set: which metric pair the field holds — 'alpha_mpc' or, for Signals,
  -- 'neutral' (see ranking.ts MetricSet).
  metric_set TEXT NOT NULL DEFAULT 'alpha_mpc',
  corr_values TEXT NOT NULL,
  mmc_values TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tournament, round_number, field_scope, metric_set)
);

CREATE TABLE IF NOT EXISTS tournament_coverage (
  tournament INTEGER PRIMARY KEY,
  earliest_round INTEGER NOT NULL,
  latest_round INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-round metrics that only submissionScores exposes (Classic mmc60, Signals
-- alpha/mpc). Fetching them returns a model's whole history in one ~420KB
-- response, so rounds are stored once here and only the still-mutable tail is
-- refetched. Rows exist only for rounds that have a score; model_score_coverage
-- below records which rounds have been looked at. See round-scores-cache.ts.
CREATE TABLE IF NOT EXISTS model_round_scores (
  model_id TEXT NOT NULL,
  tournament INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  corr REAL,
  mmc REAL,
  mmc60 REAL,
  alpha REAL,
  mpc REAL,
  -- Signals' neutral pair, from the same submissionScores call as alpha/mpc.
  neutral_corr REAL,
  neutral_mmc REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model_id, tournament, round_number)
);

-- One watermark row per model: the round range already fetched, and when the
-- mutable tail was last refreshed. Without this, recording coverage would mean
-- storing a row per unscored round — ~3x the rows, all of them empty.
CREATE TABLE IF NOT EXISTS model_score_coverage (
  model_id TEXT NOT NULL,
  tournament INTEGER NOT NULL,
  covered_from_round INTEGER NOT NULL,
  covered_to_round INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Which score columns the cached rows were written with. Coverage recorded
  -- under a different set is ignored, so rows written before a metric existed
  -- are refetched rather than served without it (see round-scores-cache.ts).
  score_fields TEXT,
  PRIMARY KEY (model_id, tournament)
);
