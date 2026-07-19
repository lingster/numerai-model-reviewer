/**
 * Rankings API — frontend client for the Worker /rankings/* REST endpoints.
 *
 * The heavy lifting (fetching all staked models' per-round performance and
 * computing ranks) now lives in the Worker against precomputed D1 data, so
 * this module is a thin client. The previous version fan-out fetched a
 * comparison pool over GraphQL; that's gone.
 *
 * Tournament-specific defaults are exposed via DEFAULT_FORMULA_FOR_TOURNAMENT
 * because each tournament has its own payout weighting: Classic (8) uses
 * 0.75*corr + 2.25*mmc, Signals (11) uses 0.3*alpha + 0.8*mpc, and Crypto (12)
 * uses 0.1*corr + 1*mmc.
 */
import type { ModelRankingHistory, RoundModelScore, ScoreFormula } from '$lib/types.js';
import { config } from '$lib/config.js';
import { swrCache } from '$lib/utils/swr-cache.svelte.js';

const SIGNALS_TOURNAMENT = 11;
const CRYPTO_TOURNAMENT = 12;

/** Default formula for Classic (corr + mmc): 0.75*corr + 2.25*mmc. */
export const DEFAULT_SCORE_FORMULA: ScoreFormula = {
	corrWeight: 0.75,
	mmcWeight: 2.25,
	tcWeight: 0
};

/**
 * Default formula for Crypto: 0.1*corr + 1*mmc (the current Crypto payout
 * weighting). Crypto has its own regime distinct from Classic's corr-heavy
 * default.
 */
export const DEFAULT_CRYPTO_SCORE_FORMULA: ScoreFormula = {
	corrWeight: 0.1,
	mmcWeight: 1.0,
	tcWeight: 0
};

/**
 * Default formula for Signals: 0.3*alpha + 0.8*mpc (the current Signals payout
 * weighting). The Worker reads alpha/mpc into the corr/mmc fields for tournament
 * 11, so corrWeight drives alpha and mmcWeight drives mpc.
 */
export const DEFAULT_SIGNALS_SCORE_FORMULA: ScoreFormula = {
	corrWeight: 0.3,
	mmcWeight: 0.8,
	tcWeight: 0
};

export function getDefaultFormulaForTournament(tournament: number): ScoreFormula {
	if (tournament === SIGNALS_TOURNAMENT) return { ...DEFAULT_SIGNALS_SCORE_FORMULA };
	if (tournament === CRYPTO_TOURNAMENT) return { ...DEFAULT_CRYPTO_SCORE_FORMULA };
	return { ...DEFAULT_SCORE_FORMULA };
}

export interface ModelRef {
	modelName: string;
	modelId?: string;
	username?: string;
}

/**
 * True when a history has at least one round with a non-null rank.
 *
 * The Worker returns a full rounds array (one entry per requested round) even
 * when the model can't be ranked — every entry's `rank` is null. That happens
 * when the model isn't in the precomputed staked field (e.g. unstaked models,
 * or models absent from the leaderboard snapshot). Such all-null histories
 * would render an empty chart with no explanation, so callers drop them and
 * surface a "no data" message instead.
 */
export function hasRankableData(history: ModelRankingHistory): boolean {
	return history.rankings.some((r) => r.rank !== null);
}

/** Why a model could (or couldn't) be ranked over the requested round range. */
export type ModelRankStatus = 'ranked' | 'unstaked' | 'no-data';

/**
 * Classify a model's ranking history over the requested range:
 *  - 'ranked'   — at least one round has a non-null rank.
 *  - 'unstaked' — never ranked, but at least one round had a populated staked
 *                 field (totalModels > 0). The round data exists; the model just
 *                 wasn't in the staked set (not staked / not a top staked model).
 *  - 'no-data'  — never ranked and no round had a field (totalModels === 0 for
 *                 every round). The cache doesn't cover this range yet.
 */
export function classifyRankingHistory(history: ModelRankingHistory): ModelRankStatus {
	if (hasRankableData(history)) return 'ranked';
	const fieldExisted = history.rankings.some((r) => r.totalModels > 0);
	return fieldExisted ? 'unstaked' : 'no-data';
}

/** A selected model that could not be ranked, with the reason why. */
export interface UnrankedModel {
	modelName: string;
	username: string;
	reason: Exclude<ModelRankStatus, 'ranked'>;
}

/** Result of calculateModelRankings: rankable histories plus unranked models. */
export interface ModelRankingsResult {
	histories: ModelRankingHistory[];
	unranked: UnrankedModel[];
}

/**
 * Latest round across the given histories that has a populated staked field
 * (totalModels > 0), or null if none do. The tail of a requested range is
 * usually unresolved (empty field), so the top-models table should default to
 * this round rather than the raw endRound — otherwise it shows "Top 0".
 */
export function latestRoundWithData(histories: ModelRankingHistory[]): number | null {
	let best: number | null = null;
	for (const history of histories) {
		for (const r of history.rankings) {
			if (r.totalModels > 0 && (best === null || r.roundNumber > best)) {
				best = r.roundNumber;
			}
		}
	}
	return best;
}

interface ModelRankRoundResponse {
	roundNumber: number;
	rank: number | null;
	corr: number | null;
	mmc: number | null;
	customScore: number | null;
	totalModels: number;
}

interface ModelRankResponse {
	modelName: string;
	username: string;
	modelId: string;
	rounds: ModelRankRoundResponse[];
}

interface TopModelResponse {
	modelName: string;
	username: string;
	rank: number;
	corr: number | null;
	mmc: number | null;
	customScore: number;
	totalModels: number;
}

/** Wrap fetch with friendly errors and JSON parsing. */
async function getJson<T>(url: URL): Promise<T> {
	const response = await fetch(url.toString(), {
		method: 'GET',
		headers: { 'Content-Type': 'application/json' }
	});
	if (!response.ok) {
		if (response.status === 404) throw new Error('Not found');
		throw new Error(`API request failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<T>;
}

/** Get the current (latest) round number for a tournament. */
export async function getCurrentRound(tournament: number = 8): Promise<number> {
	const cacheKey = `current-round:t${tournament}`;
	const cached = swrCache.get<number>(cacheKey);
	if (cached.data && !cached.isStale) return cached.data;

	return swrCache.fetch(cacheKey, async () => {
		const url = new URL(`${config.apiUrl}/rankings/current-round`);
		url.searchParams.set('tournament', String(tournament));
		const result = await getJson<{ tournament: number; round: number }>(url);
		if (!result.round) throw new Error('Could not fetch current round');
		return result.round;
	});
}

export interface CacheStatus {
	tournament: number;
	latestRound: number | null;
	earliestRound: number | null;
}

/**
 * Get the round range the precomputed cache currently covers for a tournament.
 * Returns null if the endpoint is unavailable (e.g. an older deployed Worker) so
 * callers can simply omit the coverage hint rather than error.
 */
export async function getCacheStatus(tournament: number = 8): Promise<CacheStatus | null> {
	const cacheKey = `cache-status:t${tournament}`;
	const cached = swrCache.get<CacheStatus>(cacheKey);
	if (cached.data && !cached.isStale) return cached.data;

	try {
		return await swrCache.fetch(cacheKey, async () => {
			const url = new URL(`${config.apiUrl}/rankings/cache-status`);
			url.searchParams.set('tournament', String(tournament));
			return getJson<CacheStatus>(url);
		});
	} catch (error) {
		console.error('Error fetching cache status:', error);
		return null;
	}
}

/**
 * Latest fully-resolved round for a tournament — the boundary above which rounds
 * are still "resolving" (scored but not final). Returns null when unavailable
 * (older worker or Numerai hiccup) so the chart simply treats all rounds as
 * resolved.
 */
export async function getLatestResolvedRound(tournament: number = 8): Promise<number | null> {
	const cacheKey = `latest-resolved-round:t${tournament}`;
	const cached = swrCache.get<number | null>(cacheKey);
	if (cached.data !== undefined && !cached.isStale) return cached.data;

	try {
		return await swrCache.fetch(cacheKey, async () => {
			const url = new URL(`${config.apiUrl}/rankings/latest-resolved-round`);
			url.searchParams.set('tournament', String(tournament));
			const result = await getJson<{ tournament: number; latestResolvedRound: number | null }>(url);
			return result.latestResolvedRound;
		});
	} catch (error) {
		console.error('Error fetching latest resolved round:', error);
		return null;
	}
}

/** Compute the same custom score the worker uses — kept for UI display. */
export function calculateCustomScore(
	corr: number | null,
	mmc: number | null,
	tc: number | null,
	formula: ScoreFormula
): number | null {
	if (corr === null && mmc === null && tc === null) return null;
	return (
		formula.corrWeight * (corr ?? 0) +
		formula.mmcWeight * (mmc ?? 0) +
		formula.tcWeight * (tc ?? 0)
	);
}

/**
 * Fetch ranking history for the selected models over [startRound, endRound].
 *
 * Calls the Worker /rankings/model-rank endpoint once per model (in batches
 * so we don't blast the API). Ranks are computed server-side against the
 * full staked field stored in D1 — the client no longer fetches a pool.
 */
export async function calculateModelRankings(
	selectedModels: ModelRef[],
	startRound: number,
	endRound: number,
	formula: ScoreFormula,
	tournament: number = 8,
	onProgress?: (stage: string, loaded: number, total: number) => void,
	/** Trailing round window (1 = per-round; 20/60 = MMC20/CORR60-style). */
	window: number = 1
): Promise<ModelRankingsResult> {
	if (selectedModels.length === 0) return { histories: [], unranked: [] };

	const total = selectedModels.length;
	if (onProgress) onProgress('Fetching model rankings', 0, total);

	const results: ModelRankingHistory[] = [];
	const BATCH_SIZE = 4;
	for (let i = 0; i < selectedModels.length; i += BATCH_SIZE) {
		const batch = selectedModels.slice(i, i + BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map(async (ref) => {
				const cacheKey = `model-rank:${ref.modelName.toLowerCase()}:t${tournament}:${startRound}-${endRound}:w${window}:c${formula.corrWeight}:m${formula.mmcWeight}:tc${formula.tcWeight}`;
				const cached = swrCache.get<ModelRankingHistory>(cacheKey);
				if (cached.data && !cached.isStale) return cached.data;

				return swrCache.fetch(cacheKey, async () => {
					const url = new URL(`${config.apiUrl}/rankings/model-rank`);
					url.searchParams.set('modelName', ref.modelName);
					url.searchParams.set('startRound', String(startRound));
					url.searchParams.set('endRound', String(endRound));
					url.searchParams.set('tournament', String(tournament));
					url.searchParams.set('corrWeight', String(formula.corrWeight));
					url.searchParams.set('mmcWeight', String(formula.mmcWeight));
					url.searchParams.set('tcWeight', String(formula.tcWeight));
					url.searchParams.set('window', String(window));

					try {
						const data = await getJson<ModelRankResponse>(url);
						return {
							modelId: data.modelId || ref.modelId || '',
							modelName: data.modelName || ref.modelName,
							username: data.username || ref.username || '',
							rankings: data.rounds.map((r) => ({
								roundNumber: r.roundNumber,
								rank: r.rank,
								corr: r.corr,
								mmc: r.mmc,
								customScore: r.customScore,
								totalModels: r.totalModels
							}))
						};
					} catch (error) {
						console.error(`Error fetching rank for ${ref.modelName}:`, error);
						return {
							modelId: ref.modelId || '',
							modelName: ref.modelName,
							username: ref.username || '',
							rankings: []
						};
					}
				});
			})
		);

		results.push(...batchResults);
		if (onProgress) onProgress('Fetching model rankings', results.length, total);
	}

	// Split into rankable histories (for the chart/table) and unranked models so
	// the page can explain WHY a model is missing — not staked for the range, or
	// no cached data for it — instead of silently dropping it. See
	// classifyRankingHistory.
	const histories: ModelRankingHistory[] = [];
	const unranked: UnrankedModel[] = [];
	for (const history of results) {
		const status = classifyRankingHistory(history);
		if (status === 'ranked') {
			histories.push(history);
		} else {
			unranked.push({ modelName: history.modelName, username: history.username, reason: status });
		}
	}
	return { histories, unranked };
}

/**
 * Get the top N models for a single round under the given formula. Reads the
 * precomputed field from the Worker.
 *
 * Crypto isn't precomputed today; the worker returns [] for tournament=12.
 * Returns a `RoundModelScore[]` so existing callers don't have to change.
 */
export async function getTopModelsForRound(
	roundNumber: number,
	formula: ScoreFormula,
	tournament: number = 8,
	limit: number = 10,
	/** Trailing round window (1 = per-round; 20/60 = MMC20/CORR60-style). */
	window: number = 1
): Promise<RoundModelScore[]> {
	const cacheKey = `top-models:r${roundNumber}:t${tournament}:l${limit}:w${window}:c${formula.corrWeight}:m${formula.mmcWeight}:tc${formula.tcWeight}`;
	const cached = swrCache.get<RoundModelScore[]>(cacheKey);
	if (cached.data && !cached.isStale) return cached.data;

	return swrCache.fetch(cacheKey, async () => {
		const url = new URL(`${config.apiUrl}/rankings/top-models`);
		url.searchParams.set('round', String(roundNumber));
		url.searchParams.set('tournament', String(tournament));
		url.searchParams.set('limit', String(limit));
		url.searchParams.set('corrWeight', String(formula.corrWeight));
		url.searchParams.set('mmcWeight', String(formula.mmcWeight));
		url.searchParams.set('tcWeight', String(formula.tcWeight));
		url.searchParams.set('window', String(window));

		try {
			const top = await getJson<TopModelResponse[]>(url);
			return top.map((t) => ({
				modelId: '',
				modelName: t.modelName,
				username: t.username ?? '',
				roundNumber,
				corr: t.corr,
				mmc: t.mmc,
				tc: null,
				stakeValue: null,
				customScore: t.customScore,
				rank: t.rank,
				totalModels: t.totalModels
			}));
		} catch (error) {
			console.error('Error fetching top models:', error);
			return [];
		}
	});
}

/** Re-export so callers don't need to import storage.ts for tournament checks. */
export { CRYPTO_TOURNAMENT, SIGNALS_TOURNAMENT };
