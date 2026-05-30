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

CREATE INDEX IF NOT EXISTS idx_perf_round ON model_performances(round_number, tournament);
CREATE INDEX IF NOT EXISTS idx_perf_model ON model_performances(model_name, tournament);
CREATE INDEX IF NOT EXISTS idx_cache_ttl ON graphql_cache(created_at, ttl_seconds);
