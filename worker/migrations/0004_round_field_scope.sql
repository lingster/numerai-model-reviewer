-- Give round_field_metrics a field_scope, so a round can hold both the staked
-- field and the all-models field.
--
-- WHY
--   Ranks are measured against the staked field, which is what payouts use. The
--   rankings chart can now also rank against every model that scored, staked or
--   not, and each needs its own stored metric arrays. field_scope joins the
--   primary key; existing rows are the staked field.
--
-- COST
--   Rebuilds the table (SQLite cannot extend a primary key in place). It holds
--   one row per round per tournament — a few thousand — so this is fast and the
--   copy is exact. The old table is dropped only after the copy succeeds, and
--   the whole migration runs in one transaction.
--
-- WHY NOT schema.sql
--   schema.sql creates the new shape for a fresh database, but it only ever
--   CREATEs IF NOT EXISTS: an existing table keeps its old columns, so the
--   change has to happen here. Re-running this on an already-new table is
--   harmless — the copy simply carries field_scope through.

ALTER TABLE round_field_metrics RENAME TO round_field_metrics_pre_scope;

CREATE TABLE round_field_metrics (
  tournament INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  field_scope TEXT NOT NULL DEFAULT 'staked',
  corr_values TEXT NOT NULL,
  mmc_values TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tournament, round_number, field_scope)
);

INSERT INTO round_field_metrics (tournament, round_number, field_scope, corr_values, mmc_values, updated_at)
  SELECT tournament, round_number, 'staked', corr_values, mmc_values, updated_at
    FROM round_field_metrics_pre_scope;

DROP TABLE round_field_metrics_pre_scope;
