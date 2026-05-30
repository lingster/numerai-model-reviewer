import {
  QUERY_ACCOUNT_LEADERBOARD_SEARCH,
  QUERY_ACCOUNT_LEADERBOARD_SEARCH_WITH_TOURNAMENT,
  QUERY_GET_CRYPTO_MODEL_PERFORMANCE,
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
  SIGNALS_TOURNAMENT,
  CRYPTO_TOURNAMENT,
  type RawRoundModelPerformance
} from './mappers';
import { ModelPerformance, NumeraiModel, NumeraiUser, RoundPerformance } from './types';

export interface Env {
  NUMERAI_PUBLIC_KEY: string;
  NUMERAI_SECRET_KEY: string;
  NUMERAI_API_URL: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function query<T>(
  env: Env,
  queryStr: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(env.NUMERAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${env.NUMERAI_PUBLIC_KEY}$${env.NUMERAI_SECRET_KEY}`
    },
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

export async function searchUsers(
  searchTerm: string,
  env: Env,
  limit: number = 20,
  maxSearch: number = 5000,
  batchSize: number = 500
): Promise<NumeraiUser[]> {
  const users: NumeraiUser[] = [];
  const searchLower = searchTerm.toLowerCase();

  // 1. Direct lookup
  try {
    const accountResult = await query<{
      accountProfile: { id: string; username: string } | null;
    }>(env, QUERY_SEARCH_USER_BY_ACCOUNT, { username: searchTerm });

    if (accountResult.accountProfile) {
      users.push({
        id: accountResult.accountProfile.id,
        username: accountResult.accountProfile.username
      });
    }
  } catch (e) {
    console.error('Error in direct lookup:', e);
  }

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
        models: Array<{ id: string; displayName: string; tournament: number }> | null;
      } | null;
    }>(env, q, vars);

    if (result.accountProfile?.models) {
      return result.accountProfile.models.map(m => ({
        id: m.id,
        name: m.displayName,
        username: result.accountProfile!.username,
        tournament: m.tournament
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
      rounds: mapRoundPerformances(profile.roundModelPerformances, tournament)
    };
  } catch (e) {
    console.error('Error getting model performance:', e);
    return null;
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
    const result = await query<{
      v2RoundModelPerformances: Array<{
        roundNumber: number;
        roundOpenTime: string | null;
        roundResolveTime: string | null;
        roundResolved: boolean | null;
        submissionScores: Array<{
          displayName: string;
          value: number | null;
        }>;
      }>;
    }>(env, QUERY_GET_CRYPTO_MODEL_PERFORMANCE, { modelId, tournament, lastNRounds: 100 });

    if (!result.v2RoundModelPerformances) return null;

    const rounds: RoundPerformance[] = result.v2RoundModelPerformances.map(r => {
      const scores = r.submissionScores || [];
      const getScore = (name: string) => {
        const s = scores.find(x => x.displayName === name);
        return s ? toNumber(s.value) : null;
      };

      return {
        roundNumber: r.roundNumber,
        roundOpenTime: r.roundOpenTime ?? undefined,
        roundResolveTime: r.roundResolveTime ?? undefined,
        roundResolved: r.roundResolved ?? false,
        correlation: getScore('corr'),
        corr60: null,
        mmc: getScore('mmc'),
        fnc: getScore('fnc'),
        tc: getScore('tc'),
        corrMultiplier: null,
        mmcMultiplier: null,
        selectedStakeValue: null,
        payout: null
      };
    });

    return {
      modelId,
      modelName,
      username,
      stakeValue: null,
      stakeInfo: null,
      rounds
    };
  } catch (e) {
    console.error('Error getting crypto performance:', e);
    return null;
  }
}

export async function findCryptoModelByName(
  modelName: string,
  tournament: number,
  env: Env
): Promise<NumeraiModel | null> {
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
