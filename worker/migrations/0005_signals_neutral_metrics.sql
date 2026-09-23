-- Signals' neutral pair: store it alongside alpha/mpc, and let a stored round
-- field say which pair it holds.
--
-- WHY
--   Numerai pays Signals on neutral correlation and neutral contribution for
--   rounds opening on or after 2026-09-25 (docs.numer.ai/numerai-signals/staking:
--   0.5*ncorr + 2*nmmc), instead of 0.3*alpha + 0.8*mpc. Both pairs are
--   published for the same rounds — verified against the live API, populated
--   wherever alpha/mpc is — so keeping both lets the UI rank any round either
--   way, and lets the switch happen without a re-extract.
--
--   round_field_metrics holds one metric pair per model, so a field belongs to
--   one metric set: metric_set joins its primary key, as field_scope did in
--   0004. Existing rows are alpha/mpc for Signals and the only pair there is for
--   Classic and Crypto — both are 'alpha_mpc', the default.
--
-- COST
--   model_performances.neutral_corr/neutral_mmc are not added here: they are
--   declared in schema.sql, which the self-hosted server syncs additively at
--   startup (syncSchemaColumns) and the worker deploy re-applies to D1. A
--   migration could not do both — it would fail on a fresh database, where
--   schema.sql has already created them.
--   The round_field_metrics rebuild copies a few thousand rows.
--   The index rebuild is the expensive part: ~20-30s and ~350MB on the
--   self-hosted database, because a field read now also selects the neutral
--   columns and an index that does not carry them would stop covering the
--   query — the ~17x regression 0003 exists to avoid.
--
--   SELF-HOSTED ONLY, like 0003: on D1 the index rebuild writes one row per
--   table row (~7.8M), far beyond the free plan's daily limit.

ALTER TABLE round_field_metrics RENAME TO round_field_metrics_pre_metric_set;

CREATE TABLE round_field_metrics (
  tournament INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  field_scope TEXT NOT NULL DEFAULT 'staked',
  metric_set TEXT NOT NULL DEFAULT 'alpha_mpc',
  corr_values TEXT NOT NULL,
  mmc_values TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tournament, round_number, field_scope, metric_set)
);

INSERT INTO round_field_metrics
    (tournament, round_number, field_scope, metric_set, corr_values, mmc_values, updated_at)
  SELECT tournament, round_number, field_scope, 'alpha_mpc', corr_values, mmc_values, updated_at
    FROM round_field_metrics_pre_metric_set;

DROP TABLE round_field_metrics_pre_metric_set;

-- Same name as 0003's, so tournament-coverage.ts and the query-plan tests keep
-- recognising it. Dropped first because a name cannot be reused while it
-- exists; the migration is one transaction, so a failure leaves 0003's index.
DROP INDEX IF EXISTS idx_perf_round_field;
CREATE INDEX idx_perf_round_field
  ON model_performances(tournament, round_number, model_name, stake_value, corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc);
