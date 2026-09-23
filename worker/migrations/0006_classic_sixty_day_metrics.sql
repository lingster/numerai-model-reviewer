-- Classic's 60-day pair joins the covering index, and its stored fields are
-- renamed to the metric set they actually hold.
--
-- WHY
--   Numerai pays Classic 3*CORR60 + 15*MMC60 (since 28 Aug 2026), so ranking it
--   on the 20-day pair scored one thing and called it another. corr60/mmc60 are
--   now stored per round (columns come from schema.sql via the server's startup
--   column sync), which means a field read selects them too — and an index that
--   does not carry them stops covering the query, the ~17x regression 0003
--   exists to avoid.
--
--   The metric sets are named for their pair now ('corr20_mmc', 'corr60_mmc60'),
--   so Classic and Crypto fields stored as 'alpha_mpc' — a Signals name they
--   never held — are renamed. Signals rows keep theirs.
--
-- COST
--   The index rebuild is ~20-30s and ~400MB on the self-hosted database. The
--   UPDATE touches a few thousand round_field_metrics rows.
--
--   SELF-HOSTED ONLY, like 0003 and 0005: on D1 the rebuild writes one row per
--   table row (~12M), far beyond the free plan's daily limit.
--
-- AFTER THIS
--   The renamed fields still hold 20-day metrics, which is what 'corr20_mmc'
--   means, so they stay correct. The 'corr60_mmc60' fields do not exist yet:
--   precompute writes them on its next run, or `tsx src/rebuild-fields.ts`
--   builds them from the stored rows immediately.

UPDATE round_field_metrics
   SET metric_set = 'corr20_mmc'
 WHERE metric_set = 'alpha_mpc' AND tournament != 11;

DROP INDEX IF EXISTS idx_perf_round_field;
CREATE INDEX idx_perf_round_field
  ON model_performances(
    tournament, round_number, model_name, stake_value,
    corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc, corr60, mmc60
  );
