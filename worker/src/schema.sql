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

-- Leads with tournament because every model_performances query filters on it.
-- The old (round_number, tournament) order made MIN/MAX(round_number) WHERE
-- tournament = ? scan the entire table — ~5M rows, a whole day of D1's free read
-- quota — on every rankings page load, and range queries read every tournament's
-- rows. Replaced rather than added, so inserts write no extra index row.
--
-- WARNING — do not re-run this file against the production database to pick up
-- this index. On an existing table, CREATE INDEX writes one row per table row
-- (measured: 116,752 written for 116,750 rows), i.e. ~5M rows for production —
-- about 50 days of the free plan's 100k/day write limit. Use
-- migrations/0001_perf_tournament_round_index.sql, which documents the cost and
-- the prerequisites. Creating before dropping means a failed build leaves the
-- old index in place rather than none.
CREATE INDEX IF NOT EXISTS idx_perf_tournament_round ON model_performances(tournament, round_number);
DROP INDEX IF EXISTS idx_perf_round;
CREATE INDEX IF NOT EXISTS idx_perf_model ON model_performances(model_name, tournament);
CREATE INDEX IF NOT EXISTS idx_cache_ttl ON graphql_cache(created_at, ttl_seconds);
