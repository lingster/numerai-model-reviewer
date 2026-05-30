-- Deterministic fixture for CI integration tests of /rankings/model-rank.
--
-- Uses synthetic round numbers (990001/990002) and ci_* model names so it can
-- never collide with real precomputed data in a populated cache. The tests in
-- src/lib/rankings-api.test.ts detect this seed (totalModels > 0 for the seed
-- round) and only assert against it when present.
--
-- Score formula for tournament 8: customScore = 0.75*corr + 2.25*mmc.

INSERT OR REPLACE INTO top_staked_models
  (model_id, model_name, username, stake_value, tournament, updated_at)
VALUES
  ('ci-seed-id', 'ci_seed_model', 'ci_seed_user', 100, 8, 1700000000);

-- Round 990001. Staked field (stake_value > 0), ranked by score desc:
--   ci_rival_high : 0.75*0.06   + 2.25*0.05   = 0.15750  -> rank 1
--   ci_seed_model : 0.75*0.0433 + 2.25*0.0371 = 0.11595  -> rank 2
--   ci_rival_low  : 0.75*0.01   + 2.25*0.005  = 0.01875  -> rank 3
--   ci_unstaked   : excluded (stake_value = 0)
-- => ci_seed_model: rank 2, totalModels 3.
INSERT OR REPLACE INTO model_performances
  (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at)
VALUES
  ('ci_rival_high', 990001, 0.06,   0.05,   NULL, NULL, NULL, 50,  8, 1700000000),
  ('ci_seed_model', 990001, 0.0433, 0.0371, NULL, NULL, NULL, 100, 8, 1700000000),
  ('ci_rival_low',  990001, 0.01,   0.005,  NULL, NULL, NULL, 25,  8, 1700000000),
  ('ci_unstaked',   990001, 0.09,   0.09,   NULL, NULL, NULL, 0,   8, 1700000000);

-- Round 990002:
--   ci_rival_high : 0.75*0.05   + 2.25*0.05   = 0.15000  -> rank 1
--   ci_seed_model : 0.75*0.0402 + 2.25*0.0356 = 0.11025  -> rank 2
-- => ci_seed_model: rank 2, totalModels 2.
INSERT OR REPLACE INTO model_performances
  (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at)
VALUES
  ('ci_rival_high', 990002, 0.05,   0.05,   NULL, NULL, NULL, 50,  8, 1700000000),
  ('ci_seed_model', 990002, 0.0402, 0.0356, NULL, NULL, NULL, 100, 8, 1700000000);
