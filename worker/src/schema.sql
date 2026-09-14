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
-- the existing ~5M-row table writes ~5M rows. A fresh database (CI, local dev,
-- tests) applies this file and then migrations/*.sql in order.
CREATE INDEX IF NOT EXISTS idx_perf_model ON model_performances(model_name, tournament);
CREATE INDEX IF NOT EXISTS idx_cache_ttl ON graphql_cache(created_at, ttl_seconds);

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
  PRIMARY KEY (model_id, tournament)
);
