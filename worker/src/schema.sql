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
  corr REAL,
  mmc REAL,
  tc REAL,
  stake_value REAL,
  tournament INTEGER NOT NULL DEFAULT 8,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model_name, round_number, tournament)
);

CREATE INDEX IF NOT EXISTS idx_perf_round ON model_performances(round_number, tournament);
CREATE INDEX IF NOT EXISTS idx_perf_model ON model_performances(model_name, tournament);
CREATE INDEX IF NOT EXISTS idx_cache_ttl ON graphql_cache(created_at, ttl_seconds);
