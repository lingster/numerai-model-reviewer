import {
  QUERY_ACCOUNT_LEADERBOARD_SEARCH,
  QUERY_ACCOUNT_LEADERBOARD_SEARCH_WITH_TOURNAMENT,
  QUERY_GET_CRYPTO_MODEL_PERFORMANCE,
  QUERY_GET_CRYPTO_ROUND_METADATA,
  QUERY_GET_MODEL_BY_NAME,
  QUERY_GET_MODEL_PERFORMANCE,
  QUERY_GET_SIGNALS_MODEL_BY_NAME,
  QUERY_GET_SIGNALS_MODEL_PERFORMANCE,
  QUERY_GET_USER_MODELS,
  QUERY_GET_USER_MODELS_WITH_TOURNAMENT,
  QUERY_SEARCH_USER_BY_ACCOUNT,
  QUERY_SEARCH_USER_BY_MODEL
} from './queries';
import {
  mapRoundPerformances,
  toNumber,
  CLASSIC_TOURNAMENT,
  SIGNALS_TOURNAMENT,
  CRYPTO_TOURNAMENT,
  MAX_ROUNDS_HISTORY,
  type RawRoundModelPerformance
} from './mappers';
import { ModelPerformance, NumeraiModel, NumeraiUser, RoundPerformance } from './types';
import { d1Retry } from './d1-retry';
import {
  emptyRoundScores,
  readCachedRoundScores,
  writeRoundScores,
  computeFetchWindow,
  diffRoundScores,
  SCORE_FIELDS,
  type RoundScores
} from './round-scores-cache';

export interface Env {
  // Optional: every query here reads public data, which Numerai serves anonymously.
  NUMERAI_PUBLIC_KEY?: string;
  NUMERAI_SECRET_KEY?: string;
  NUMERAI_API_URL: string;
  // D1 holds precomputed staked models (username + model_name per tournament),
  // used as a fast-path index for user search.
  DB: D1Database;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** Headers for a Numerai call; Authorization only when both keys are set. */
function numeraiHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.NUMERAI_PUBLIC_KEY && env.NUMERAI_SECRET_KEY) {
    headers.Authorization = `Token ${env.NUMERAI_PUBLIC_KEY}$${env.NUMERAI_SECRET_KEY}`;
  }
  return headers;
}

async function query<T>(
  env: Env,
  queryStr: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(env.NUMERAI_API_URL, {
    method: 'POST',
    headers: numeraiHeaders(env),
    body: JSON.stringify({
      query: queryStr,
      variables
    })
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const result: GraphQLResponse<T> = await response.json();

  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join(', '));
  }

  if (!result.data) {
    throw new Error('No data returned from API');
  }

  return result.data;
}

/**
 * Fast-path search over precomputed staked models in D1. Matches the query as a
 * case-insensitive substring of either the account/username or the model name,
 * and returns distinct usernames. Anyone with stake (i.e. anyone who has
 * rankings to show) is here, so this resolves the common case in a single
 * indexed query — avoiding the multi-page leaderboard scan below.
 */
async function searchStakedUsernames(
  env: Env,
  searchLower: string,
  limit: number
): Promise<string[]> {
  if (!env.DB) return [];
  const like = `%${searchLower}%`;
  const result = await d1Retry(() =>
    env.DB.prepare(
      `SELECT DISTINCT username FROM top_staked_models
        WHERE username != '' AND (LOWER(username) LIKE ? OR LOWER(model_name) LIKE ?)
        ORDER BY username
        LIMIT ?`
    )
      .bind(like, like, limit)
      .all<{ username: string }>()
  );
  return (result.results ?? []).map((r) => r.username).filter(Boolean);
}

export async function searchUsers(
  searchTerm: string,
  env: Env,
  limit: number = 20,
  maxSearch: number = 5000,
  batchSize: number = 500
): Promise<NumeraiUser[]> {
  const users: NumeraiUser[] = [];
  const searchLower = searchTerm.toLowerCase();

  // 0. Fast path: precomputed staked models in D1 (one indexed query). Covers
  // the vast majority of real searches instantly; only fall through to the slow
  // live leaderboard scan when D1 can't fill the result set.
  try {
    for (const username of await searchStakedUsernames(env, searchLower, limit)) {
      if (!users.find((u) => u.username.toLowerCase() === username.toLowerCase())) {
        users.push({ id: username, username });
      }
    }
  } catch (e) {
    console.error('Error in D1 user search:', e);
  }

  if (users.length >= limit) return users.slice(0, limit);

  // 1. Direct lookup (single exact-match query — catches unstaked accounts the
  // D1 index doesn't have).
  try {
    const accountResult = await query<{
      accountProfile: { id: string; username: string } | null;
    }>(env, QUERY_SEARCH_USER_BY_ACCOUNT, { username: searchTerm });

    if (accountResult.accountProfile) {
      if (!users.find((u) => u.username.toLowerCase() === accountResult.accountProfile!.username.toLowerCase())) {
        users.push({
          id: accountResult.accountProfile.id,
          username: accountResult.accountProfile.username
        });
      }
    }
  } catch (e) {
    console.error('Error in direct lookup:', e);
  }

  // The cheap paths (D1 + exact lookup) resolve the overwhelming majority of
  // searches. Only fall through to the slow multi-page leaderboard scan when
  // they turned up nothing — that's the case that was making search feel slow.
  if (users.length > 0) return users.slice(0, limit);

  // 2. Leaderboard Search
  let offset = 0;
  while (users.length < limit && offset < maxSearch) {
    try {
      const result = await query<{
        accountLeaderboard: Array<{ id: string; username: string }>;
      }>(
        env, 
        QUERY_ACCOUNT_LEADERBOARD_SEARCH, 
        { limit: batchSize, offset }
      );

      const batch = result.accountLeaderboard || [];
      if (batch.length === 0) break;

      for (const entry of batch) {
        if (entry.username.toLowerCase().includes(searchLower)) {
          if (!users.find(u => u.username.toLowerCase() === entry.username.toLowerCase())) {
            users.push({ id: entry.id, username: entry.username });
            if (users.length >= limit) break;
          }
        }
      }

      if (batch.length < batchSize) break;
      offset += batchSize;
    } catch (e) {
      console.error('Error in leaderboard search:', e);
      break;
    }
  }

  // 3. Model Name Lookup
  if (users.length < limit) {
    try {
      const modelResult = await query<{
        v3UserProfile: { id: string; accountName: string } | null;
      }>(env, QUERY_SEARCH_USER_BY_MODEL, { modelName: searchTerm });

      if (modelResult.v3UserProfile?.accountName) {
        const name = modelResult.v3UserProfile.accountName;
        if (!users.find(u => u.username.toLowerCase() === name.toLowerCase())) {
          users.push({ id: name, username: name });
        }
      }
    } catch (e) {
      console.error('Error in model lookup:', e);
    }
  }

  return users;
}

// Short-lived cache of per-account model lists keyed by (username, tournament).
// Comparing many models from one account otherwise issues one identical
// accountProfile lookup per model (e.g. when resolving Crypto stake). Caching
// the in-flight Promise also coalesces concurrent identical lookups.
const USER_MODELS_TTL_MS = 60_000;
const userModelsCache = new Map<string, { at: number; models: Promise<NumeraiModel[]> }>();

/** Clear the per-account model cache. Exposed for test isolation. */
export function clearUserModelsCache(): void {
  userModelsCache.clear();
}

/**
 * getUserModels with a short TTL cache keyed by (username, tournament). A
 * rejected lookup is evicted so the next caller retries rather than caching the
 * failure.
 */
export function getUserModelsCached(
  username: string,
  env: Env,
  tournament?: number
): Promise<NumeraiModel[]> {
  const key = `${username.toLowerCase()}:${tournament ?? 'all'}`;
  const hit = userModelsCache.get(key);
  if (hit && Date.now() - hit.at < USER_MODELS_TTL_MS) return hit.models;

  const models = getUserModels(username, env, tournament);
  userModelsCache.set(key, { at: Date.now(), models });
  models.catch(() => userModelsCache.delete(key));
  return models;
}

export async function getUserModels(
  username: string,
  env: Env,
  tournament?: number
): Promise<NumeraiModel[]> {
  try {
    const q = tournament ? QUERY_GET_USER_MODELS_WITH_TOURNAMENT : QUERY_GET_USER_MODELS;
    const vars = tournament ? { username, tournament } : { username };

    const result = await query<{
      accountProfile: {
        id: string;
        username: string;
        models: Array<{
          id: string;
          displayName: string;
          tournament: number;
          stake: string | number | null;
          return1y: number | null;
        }> | null;
      } | null;
    }>(env, q, vars);

    if (result.accountProfile?.models) {
      return result.accountProfile.models.map(m => ({
        id: m.id,
        name: m.displayName,
        username: result.accountProfile!.username,
        tournament: m.tournament,
        stake: m.stake !== null && m.stake !== undefined ? Number(m.stake) : null,
        return1y: m.return1y ?? null
      }));
    }

    // Fallback: the input may be a model name rather than an account name.
    // Resolve it via the tournament-aware lookup (handles Signals + Classic).
    if (tournament !== CRYPTO_TOURNAMENT) {
      const model = await getModelByName(username, env, tournament);
      if (model) {
        if (model.username.toLowerCase() !== username.toLowerCase()) {
          return getUserModels(model.username, env, tournament);
        }
        return [model];
      }
    }

    return [];
  } catch (e) {
    console.error('Error getting user models:', e);
    return [];
  }
}

export async function getModelByName(
  modelName: string,
  env: Env,
  tournament?: number
): Promise<NumeraiModel | null> {
  // Signals models are not exposed by v3UserProfile; use v2SignalsProfile.
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const lookupQuery = isSignals ? QUERY_GET_SIGNALS_MODEL_BY_NAME : QUERY_GET_MODEL_BY_NAME;

  try {
    const result = await query<{
      v3UserProfile?: ModelProfileLookup | null;
      v2SignalsProfile?: ModelProfileLookup | null;
    }>(env, lookupQuery, { modelName });

    const profile = isSignals ? result.v2SignalsProfile : result.v3UserProfile;
    if (profile) {
      return {
        id: profile.id,
        name: profile.username,
        username: profile.accountName,
        tournament: profile.tournament
      };
    }
    return null;
  } catch (e) {
    console.error('Error getting model by name:', e);
    return null;
  }
}

/** Shared shape returned by both lookup queries. */
interface ModelProfileLookup {
  id: string;
  username: string;
  accountName: string;
  tournament: number;
}

export async function getModelPerformance(
  modelName: string,
  env: Env,
  username?: string,
  modelId?: string,
  tournament?: number
): Promise<ModelPerformance | null> {
  // Crypto logic
  if (tournament === CRYPTO_TOURNAMENT && modelId) {
    // Need username for the response structure, if not provided assume modelName owner (approx)
    // In crypto, v2RoundModelPerformances doesn't return owner.
    return fetchCryptoModelPerformance(modelName, username || '', modelId, tournament, env);
  }

  // Signals models are not exposed by v3UserProfile; use v2SignalsProfile.
  // Both return the same V3UserProfile shape, so the mapping is shared.
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const performanceQuery = isSignals
    ? QUERY_GET_SIGNALS_MODEL_PERFORMANCE
    : QUERY_GET_MODEL_PERFORMANCE;

  try {
    const result = await query<{
      v3UserProfile?: UserProfilePerformance | null;
      v2SignalsProfile?: UserProfilePerformance | null;
    }>(env, performanceQuery, { modelName });

    const profile = isSignals ? result.v2SignalsProfile : result.v3UserProfile;
    if (!profile) return null;

    const rounds = mapRoundPerformances(profile.roundModelPerformances, tournament);

    // Both Signals (alpha/mpc) and Classic (mmc60) keep metrics that
    // roundModelPerformances does not expose in submissionScores on
    // v2RoundModelPerformances, keyed by modelId — merge them in by round.
    // profile.id is the model UUID the score query needs, and is always present
    // here — unlike the caller's optional modelId.
    await augmentWithSubmissionScores(
      rounds,
      profile.id,
      isSignals ? SIGNALS_TOURNAMENT : (tournament ?? CLASSIC_TOURNAMENT),
      env
    );

    return {
      modelId: profile.id,
      modelName: profile.username,
      username: profile.accountName,
      stakeValue: toNumber(profile.stakeValue),
      stakeInfo: profile.stakeInfo ? {
        corrMultiplier: toNumber(profile.stakeInfo.corrMultiplier),
        mmcMultiplier: toNumber(profile.stakeInfo.mmcMultiplier),
        tcMultiplier: toNumber(profile.stakeInfo.tcMultiplier)
      } : null,
      rounds
    };
  } catch (e) {
    console.error('Error getting model performance:', e);
    return null;
  }
}

interface RoundSubmissionScores {
  v2RoundModelPerformances: Array<{
    roundNumber: number;
    submissionScores: Array<{ displayName: string; value: number | null }> | null;
  }> | null;
}

/**
 * Fetch per-round submission scores (keyed displayName -> value) for a model.
 * This is the only source of alpha/mpc (Signals), mmc60 (Classic) and the whole
 * score set (Crypto) — `roundModelPerformances` exposes none of them.
 *
 * `lastNRounds` is a round-number window, not a count: passing 3 when the newest
 * rounds are still unscored returns nothing, which is why callers size it from
 * the latest round rather than from how many rounds they want.
 */
async function fetchSubmissionScoresByRound(
  modelId: string,
  tournament: number,
  env: Env,
  lastNRounds = MAX_ROUNDS_HISTORY
): Promise<Map<number, Map<string, number | null>>> {
  const result = await query<RoundSubmissionScores>(env, QUERY_GET_CRYPTO_MODEL_PERFORMANCE, {
    modelId,
    tournament,
    lastNRounds
  });

  const byRound = new Map<number, Map<string, number | null>>();
  for (const r of result.v2RoundModelPerformances ?? []) {
    const scores = new Map<string, number | null>();
    for (const s of r.submissionScores ?? []) {
      scores.set(s.displayName, toNumber(s.value));
    }
    byRound.set(r.roundNumber, scores);
  }
  return byRound;
}

/**
 * Which submissionScores keys each tournament is scored on. Anything outside
 * this set is absent upstream anyway — Crypto's score list has no fnc, tc,
 * mmc60, alpha or mpc at all — so reading or storing it would be dead weight.
 */
const SCORED_FIELDS_BY_TOURNAMENT: Record<number, readonly (keyof RoundScores)[]> = {
  [CLASSIC_TOURNAMENT]: ['mmc60'],
  [SIGNALS_TOURNAMENT]: ['alpha', 'mpc', 'neutral_corr', 'neutral_mmc'],
  [CRYPTO_TOURNAMENT]: ['corr', 'mmc']
};

/**
 * The submission-sourced metrics for every round of a model, served from D1 and
 * topped up from the API.
 *
 * The upstream call has no per-round granularity — it returns a model's entire
 * scored history (~420KB) however little we need — so the persistent cache is
 * what keeps this cheap: a model's history is downloaded once, and subsequent
 * requests fetch only the rounds added since, plus the ~70-round tail whose
 * scores can still change.
 */
async function getAugmentationScores(
  modelId: string,
  tournament: number,
  roundNumbers: number[],
  env: Env
): Promise<Map<number, RoundScores>> {
  const latestRound = Math.max(...roundNumbers);
  const now = Math.floor(Date.now() / 1000);

  let cached = new Map<number, RoundScores>();
  let coverage = null;
  try {
    if (env.DB) {
      const stored = await readCachedRoundScores(env.DB, modelId, tournament);
      cached = stored.scores;
      coverage = stored.coverage;
    }
  } catch (e) {
    // Cache miss by another name: fall through to a full fetch.
    console.error('round-scores cache read failed:', e);
  }

  const window = computeFetchWindow(coverage, latestRound, MAX_ROUNDS_HISTORY, now);
  if (window === null) return cached;

  const fetched = await fetchSubmissionScoresByRound(modelId, tournament, env, window);

  // Read only the fields this tournament is scored on; the rest stay null and
  // are dropped from the write by diffRoundScores.
  const wanted = SCORED_FIELDS_BY_TOURNAMENT[tournament] ?? SCORE_FIELDS;
  const fresh = new Map<number, RoundScores>();
  for (const [round, scores] of fetched) {
    const next = emptyRoundScores();
    for (const field of wanted) {
      next[field] = scores.get(field) ?? null;
    }
    fresh.set(round, next);
  }

  try {
    if (env.DB) {
      // Only rounds whose values actually moved are written; the watermark
      // records the rest of the window as looked-at.
      const changed = diffRoundScores(cached, fresh);
      await writeRoundScores(env.DB, modelId, tournament, changed, {
        fromRound: Math.min(coverage?.fromRound ?? Infinity, latestRound - window + 1),
        toRound: Math.max(coverage?.toRound ?? -Infinity, latestRound),
        updatedAt: now
      });
    }
  } catch (e) {
    // Best-effort: a failed write just means we fetch again next time.
    console.error('round-scores cache write failed:', e);
  }

  // Freshly fetched rounds win over cached ones — that is the point of the tail.
  return new Map([...cached, ...fresh]);
}

/**
 * Merge the per-round metrics that only submissionScores carries into
 * already-mapped rounds, by round number.
 *
 * `roundModelPerformances` exposes corr/corr60/mmc/tc but neither the new
 * Signals scoring (alpha/mpc) nor Classic's 60-day MMC, so both are read from
 * the score set here. A metric absent for a tournament simply stays null.
 */
async function augmentWithSubmissionScores(
  rounds: RoundPerformance[],
  modelId: string,
  tournament: number,
  env: Env
): Promise<void> {
  if (rounds.length === 0) return;

  try {
    const roundNumbers = rounds.map((r) => r.roundNumber);
    const byRound = await getAugmentationScores(modelId, tournament, roundNumbers, env);
    for (const round of rounds) {
      const scores = byRound.get(round.roundNumber);
      if (!scores) continue;
      round.alpha = scores.alpha;
      round.mpc = scores.mpc;
      round.mmc60 = scores.mmc60;
      round.neutralCorr = scores.neutral_corr;
      round.neutralMmc = scores.neutral_mmc;
    }
  } catch (e) {
    // Non-fatal: these metrics just stay null if the augmentation query fails.
    console.error('Error augmenting submission scores:', e);
  }
}

/** Shared shape returned by both `v3UserProfile` and `v2SignalsProfile`. */
interface UserProfilePerformance {
  id: string;
  username: string;
  accountName: string;
  stakeValue?: number | string;
  stakeInfo?: {
    corrMultiplier?: number;
    mmcMultiplier?: number;
    tcMultiplier?: number;
  };
  roundModelPerformances: RawRoundModelPerformance[];
}

async function fetchCryptoModelPerformance(
  modelName: string,
  username: string,
  modelId: string,
  tournament: number,
  env: Env
): Promise<ModelPerformance | null> {
  try {
    type CryptoRoundMetadata = {
      v2RoundModelPerformances: Array<{
        roundNumber: number;
        roundOpenTime: string | null;
        roundResolveTime: string | null;
        roundResolved: boolean | null;
        corrMultiplier: number | null;
        mmcMultiplier: number | null;
        payoutMultipliers: Array<{
          name: string;
          displayName: string;
          multiplier: number;
        }> | null;
      }> | null;
    };

    // Crypto's round performances carry no stake — source the current stake from
    // the account's ModelProfile.stake (matched by model id). Non-fatal on error.
    // The two calls are independent, so they run together rather than in series.
    const [result, stakeValue] = await Promise.all([
      query<CryptoRoundMetadata>(env, QUERY_GET_CRYPTO_ROUND_METADATA, {
        modelId,
        tournament,
        lastNRounds: MAX_ROUNDS_HISTORY
      }),
      fetchCryptoStake(username, modelId, tournament, env)
    ]);

    if (!result.v2RoundModelPerformances) return null;

    // Crypto is scored purely on corr and mmc, and only submissionScores carries
    // them — fetched through the same incremental cache as the other
    // tournaments, so the history is downloaded once rather than per request.
    const roundNumbers = result.v2RoundModelPerformances.map(r => r.roundNumber);
    const scoresByRound = roundNumbers.length
      ? await getAugmentationScores(modelId, tournament, roundNumbers, env)
      : new Map<number, RoundScores>();

    const rounds: RoundPerformance[] = result.v2RoundModelPerformances.map(r => {
      const scores = scoresByRound.get(r.roundNumber);

      return {
        roundNumber: r.roundNumber,
        roundOpenTime: r.roundOpenTime ?? undefined,
        roundResolveTime: r.roundResolveTime ?? undefined,
        roundResolved: r.roundResolved ?? false,
        correlation: scores?.corr ?? null,
        mmc: scores?.mmc ?? null,
        // Crypto publishes none of these: its score list is corr/mmc only.
        corr60: null,
        mmc60: null,
        fnc: null,
        tc: null,
        alpha: null,
        mpc: null,
        corrMultiplier: toNumber(r.corrMultiplier),
        mmcMultiplier: toNumber(r.mmcMultiplier),
        payoutMultipliers: r.payoutMultipliers ?? null,
        selectedStakeValue: null,
        payout: null
      };
    });

    return {
      modelId,
      modelName,
      username,
      stakeValue,
      stakeInfo: null,
      rounds
    };
  } catch (e) {
    console.error('Error getting crypto performance:', e);
    return null;
  }
}

/**
 * Resolve a Crypto model's current stake (NMR) from the account's models.
 * v2RoundModelPerformances omits stake, so we read ModelProfile.stake (a string
 * coerced to number by getUserModels) matched by model id. Returns null if the
 * username is unknown, the lookup fails, or the model isn't found.
 */
async function fetchCryptoStake(
  username: string,
  modelId: string,
  tournament: number,
  env: Env
): Promise<number | null> {
  if (!username) return null;
  try {
    const models = await getUserModelsCached(username, env, tournament);
    return models.find(m => m.id === modelId)?.stake ?? null;
  } catch (e) {
    console.error('Error fetching crypto stake:', e);
    return null;
  }
}

/**
 * Single PK-indexed lookup of a precomputed staked model by (name, tournament)
 * from D1. `top_staked_models` carries model_id + username, so this resolves a
 * model with no Numerai API call. Exact-match keeps it on the PRIMARY KEY index
 * (Numerai model names are canonical lowercase).
 */
async function findStakedModelInD1(
  env: Env,
  modelName: string,
  tournament: number
): Promise<NumeraiModel | null> {
  if (!env.DB) return null;
  try {
    const row = await d1Retry(() =>
      env.DB.prepare(
        `SELECT model_id, model_name, username, tournament
           FROM top_staked_models WHERE model_name = ? AND tournament = ?`
      )
        .bind(modelName, tournament)
        .first<{ model_id: string; model_name: string; username: string; tournament: number }>()
    );
    if (!row) return null;
    return { id: row.model_id, name: row.model_name, username: row.username, tournament: row.tournament };
  } catch (e) {
    console.error('Error looking up staked model in D1:', e);
    return null;
  }
}

export async function findCryptoModelByName(
  modelName: string,
  tournament: number,
  env: Env,
  username?: string
): Promise<NumeraiModel | null> {
  // Fast path: every staked crypto model is precomputed in D1, indexed by the
  // (model_name, tournament) primary key — one lookup, zero API calls.
  const staked = await findStakedModelInD1(env, modelName, tournament);
  if (staked) return staked;

  // Known owner (e.g. the URL's `user=` param): a single getUserModels call
  // instead of paging the entire leaderboard.
  if (username) {
    const userModels = await getUserModels(username, env, tournament);
    const model = userModels.find((m) => m.name.toLowerCase() === modelName.toLowerCase());
    if (model) return model;
  }

  // Last resort (unstaked model with no known owner): bounded leaderboard scan.
  const batchSize = 500;
  const maxSearchUsers = 2000;
  let offset = 0;

  while (offset < maxSearchUsers) {
    try {
      const result = await query<{
        accountLeaderboard: Array<{ id: string; username: string }>;
      }>(
        env,
        QUERY_ACCOUNT_LEADERBOARD_SEARCH_WITH_TOURNAMENT,
        { limit: batchSize, offset, tournament }
      );

      const batch = result.accountLeaderboard || [];
      if (batch.length === 0) break;

      // Check each user for the model
      for (const user of batch) {
        // We need to fetch user models to check if they have this model
        // This is expensive (N+1) but that's how the frontend did it
        // Optimizing this would require a different API from Numerai
        const userModels = await getUserModels(user.username, env, tournament);
        const model = userModels.find(
          (m) => m.name.toLowerCase() === modelName.toLowerCase()
        );
        if (model) {
          return model;
        }
      }

      offset += batchSize;
      if (batch.length < batchSize) break;
    } catch (e) {
      console.error('Error searching for Crypto model:', e);
      break;
    }
  }

  return null;
}
