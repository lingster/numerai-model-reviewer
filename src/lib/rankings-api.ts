/**
 * Rankings API - Functions for fetching round leaderboard data
 * Used to calculate model rankings based on custom score formulas
 */
import type { RoundModelScore, ScoreFormula, ModelRankingHistory } from '$lib/types.js';
import { config } from '$lib/config.js';
import { swrCache } from '$lib/utils/swr-cache.svelte.js';

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

// Default score formula: 2.25*mmc + 0.75*corr
export const DEFAULT_SCORE_FORMULA: ScoreFormula = {
	mmcWeight: 2.25,
	corrWeight: 0.75,
	tcWeight: 0
};

// Crypto tournament does not expose v3UserProfile; it requires the v2 round API.
const CRYPTO_TOURNAMENT = 12;

// Default comparison-pool size. Kept modest so a cold-cache calculation stays
// within a reasonable wall-clock time given the rate limit below; the SWR cache
// makes repeat loads fast.
const DEFAULT_COMPARISON_POOL_SIZE = 200;

// Rate limiting configuration
const RATE_LIMIT = {
	requestsPerMinute: 30,
	minDelayMs: 2000 // Minimum delay between requests
};

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delay (ms) required after firing `requestsInBatch` parallel requests so that
 * the effective request cadence does not exceed `RATE_LIMIT.requestsPerMinute`.
 * A batch of N concurrent requests must be followed by N requests' worth of the
 * per-minute budget, otherwise parallel batches silently blow past the limit.
 */
function batchDelayMs(requestsInBatch: number): number {
	const budgetMs = (requestsInBatch / RATE_LIMIT.requestsPerMinute) * 60_000;
	return Math.max(RATE_LIMIT.minDelayMs, Math.ceil(budgetMs));
}

/**
 * Execute a GraphQL query against the backend proxy
 */
async function query<T>(graphqlQuery: string, variables?: Record<string, unknown>): Promise<T> {
	const response = await fetch(`${config.apiUrl}/graphql`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			query: graphqlQuery,
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
 * Coerce a GraphQL numeric/decimal value (which may arrive as a string, e.g.
 * `selectedStakeValue: "0.000..."`) into a finite number, or null.
 */
function toNumber(value: number | string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Get the current round number
 */
export async function getCurrentRound(tournament: number = 8): Promise<number> {
	const cacheKey = `current-round:t${tournament}`;

	const cached = swrCache.get<number>(cacheKey);
	if (cached.data && !cached.isStale) {
		return cached.data;
	}

	return swrCache.fetch(cacheKey, async () => {
		const result = await query<{
			rounds: Array<{ number: number }>;
		}>(`
			query getCurrentRound($tournament: Int!) {
				rounds(tournament: $tournament, limit: 1) {
					number
				}
			}
		`, { tournament });

		if (!result.rounds || result.rounds.length === 0) {
			throw new Error('Could not fetch current round');
		}

		return result.rounds[0].number;
	});
}

/**
 * A model reference used to fetch round performance. `modelId` is required for
 * Crypto (tournament 12) because that tournament has no `v3UserProfile`.
 */
export interface ModelRef {
	modelName: string;
	modelId?: string;
	username?: string;
}

/**
 * Fetch resolved round performance for a single Classic/Signals model via
 * `v3UserProfile` (keyed by model name).
 */
async function fetchProfileRoundPerformance(modelName: string): Promise<RoundModelScore[]> {
	const result = await query<{
		v3UserProfile: {
			id: string;
			username: string;
			accountName: string;
			roundModelPerformances: Array<{
				roundNumber: number;
				corr: number | string | null;
				corr20V2: number | string | null;
				mmc: number | string | null;
				tc: number | string | null;
				selectedStakeValue: number | string | null;
				roundResolved: boolean | null;
			}>;
		} | null;
	}>(`
		query getModelRoundPerformance($modelName: String!) {
			v3UserProfile(modelName: $modelName) {
				id
				username
				accountName
				roundModelPerformances {
					roundNumber
					corr
					corr20V2
					mmc
					tc
					selectedStakeValue
					roundResolved
				}
			}
		}
	`, { modelName });

	if (!result.v3UserProfile) {
		return [];
	}

	return result.v3UserProfile.roundModelPerformances
		.filter(r => r.roundResolved)
		.map(r => ({
			modelId: result.v3UserProfile!.id,
			modelName: result.v3UserProfile!.username,
			username: result.v3UserProfile!.accountName,
			roundNumber: r.roundNumber,
			corr: toNumber(r.corr20V2) ?? toNumber(r.corr),
			mmc: toNumber(r.mmc),
			tc: toNumber(r.tc),
			stakeValue: toNumber(r.selectedStakeValue),
			customScore: null,
			rank: null
		}));
}

/**
 * Fetch resolved round performance for a single Crypto model via the v2 round
 * API. Crypto has no `v3UserProfile`, so this path is required for tournament 12
 * and needs the model UUID. Scores are reported per submission metric.
 */
async function fetchCryptoRoundPerformance(ref: ModelRef): Promise<RoundModelScore[]> {
	if (!ref.modelId) {
		return [];
	}

	const result = await query<{
		v2RoundModelPerformances: Array<{
			roundNumber: number;
			roundResolved: boolean | null;
			submissionScores: Array<{ displayName: string; value: number | string | null }> | null;
		}>;
	}>(`
		query getCryptoModelRoundPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
			v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
				roundNumber
				roundResolved
				submissionScores {
					displayName
					value
				}
			}
		}
	`, { modelId: ref.modelId, tournament: CRYPTO_TOURNAMENT, lastNRounds: 100 });

	if (!result.v2RoundModelPerformances) {
		return [];
	}

	return result.v2RoundModelPerformances
		.filter(r => r.roundResolved)
		.map(r => {
			const scores = r.submissionScores ?? [];
			const getScore = (name: string): number | null => {
				const match = scores.find(s => s.displayName === name);
				return match ? toNumber(match.value) : null;
			};
			return {
				modelId: ref.modelId!,
				modelName: ref.modelName,
				username: ref.username ?? '',
				roundNumber: r.roundNumber,
				corr: getScore('corr'),
				mmc: getScore('mmc'),
				tc: getScore('tc'),
				stakeValue: null,
				customScore: null,
				rank: null
			};
		});
}

/**
 * Fetch performance data for multiple models for a specific round.
 * This is the main function used to get ranking data. Classic/Signals models go
 * through `v3UserProfile`; Crypto (tournament 12) models route through the
 * Crypto-specific v2 round API since `v3UserProfile` returns null for them.
 */
export async function fetchModelsRoundPerformance(
	models: ModelRef[],
	tournament: number = 8,
	onProgress?: (loaded: number, total: number) => void
): Promise<Map<string, RoundModelScore[]>> {
	const results = new Map<string, RoundModelScore[]>();
	const total = models.length;
	let loaded = 0;
	const isCrypto = tournament === CRYPTO_TOURNAMENT;

	// Process models in batches to respect rate limits
	const batchSize = 5;

	for (let i = 0; i < models.length; i += batchSize) {
		const batch = models.slice(i, i + batchSize);

		// Fetch batch in parallel
		const batchPromises = batch.map(async (ref) => {
			const cacheKey = `model-rounds:${ref.modelName.toLowerCase()}:t${tournament}`;

			const cached = swrCache.get<RoundModelScore[]>(cacheKey);
			if (cached.data && !cached.isStale) {
				return { modelName: ref.modelName, data: cached.data };
			}

			try {
				const data = await swrCache.fetch(cacheKey, () =>
					isCrypto ? fetchCryptoRoundPerformance(ref) : fetchProfileRoundPerformance(ref.modelName)
				);

				return { modelName: ref.modelName, data };
			} catch (error) {
				console.error(`Error fetching performance for ${ref.modelName}:`, error);
				return { modelName: ref.modelName, data: [] };
			}
		});

		const batchResults = await Promise.all(batchPromises);

		for (const { modelName, data } of batchResults) {
			results.set(modelName.toLowerCase(), data);
			loaded++;
			if (onProgress) {
				onProgress(loaded, total);
			}
		}

		// Rate limiting between batches — spaced so the effective cadence of the
		// parallel batch respects RATE_LIMIT.requestsPerMinute.
		if (i + batchSize < models.length) {
			await sleep(batchDelayMs(batch.length));
		}
	}

	return results;
}

/**
 * Calculate custom score based on formula
 */
export function calculateCustomScore(
	corr: number | null,
	mmc: number | null,
	tc: number | null,
	formula: ScoreFormula
): number | null {
	const corrValue = corr ?? 0;
	const mmcValue = mmc ?? 0;
	const tcValue = tc ?? 0;

	// If all values are null, return null
	if (corr === null && mmc === null && tc === null) {
		return null;
	}

	return (formula.corrWeight * corrValue) +
		   (formula.mmcWeight * mmcValue) +
		   (formula.tcWeight * tcValue);
}

/** A model entry from the leaderboard, used to build the comparison pool. */
export interface ComparisonPoolModel {
	modelId: string;
	modelName: string;
	username: string;
}

/**
 * Fetch one page of the Classic/Signals comparison pool. Each `accountLeaderboard`
 * entry is itself a model row (id = model id, displayName = model name) and is
 * already filtered by the tournament arg.
 */
async function fetchAccountLeaderboardBatch(
	tournament: number,
	limit: number,
	offset: number
): Promise<ComparisonPoolModel[]> {
	const result = await query<{
		accountLeaderboard: Array<{ id: string; username: string; displayName: string | null }>;
	}>(`
		query getComparisonPool($limit: Int!, $offset: Int!, $tournament: Int!) {
			accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
				id
				username
				displayName
			}
		}
	`, { limit, offset, tournament });

	return (result.accountLeaderboard ?? [])
		.filter(e => e.displayName)
		.map(e => ({ modelId: e.id, modelName: e.displayName!, username: e.username }));
}

/**
 * Fetch one page of the Crypto comparison pool. The Crypto `accountLeaderboard`
 * is account-level (its `id` is an account id, unusable with v2RoundModelPerformances),
 * so the model-level `cryptosignalsLeaderboard` is used instead — there `id` is the
 * model UUID and `username` is the model name.
 */
async function fetchCryptoLeaderboardBatch(
	limit: number,
	offset: number
): Promise<ComparisonPoolModel[]> {
	const result = await query<{
		cryptosignalsLeaderboard: Array<{ id: string; username: string }>;
	}>(`
		query getCryptoComparisonPool($limit: Int!, $offset: Int!) {
			cryptosignalsLeaderboard(limit: $limit, offset: $offset) {
				id
				username
			}
		}
	`, { limit, offset });

	return (result.cryptosignalsLeaderboard ?? [])
		.filter(e => e.id && e.username)
		.map(e => ({ modelId: e.id, modelName: e.username, username: e.username }));
}

/**
 * Fetch the comparison pool of models from the leaderboard.
 *
 * Returns the first `limit` models in the leaderboard's API-defined order (the
 * leaderboard endpoint does not sort by stake, so this is not a "top staked"
 * list). Stake values are not fetched here — ranking is computed later from
 * per-model round performance.
 */
export async function fetchComparisonPoolModels(
	tournament: number = 8,
	limit: number = DEFAULT_COMPARISON_POOL_SIZE,
	onProgress?: (loaded: number, total: number) => void
): Promise<ComparisonPoolModel[]> {
	const cacheKey = `comparison-pool:t${tournament}:l${limit}`;

	const cached = swrCache.get<ComparisonPoolModel[]>(cacheKey);
	if (cached.data && !cached.isStale) {
		return cached.data;
	}

	const isCrypto = tournament === CRYPTO_TOURNAMENT;

	return swrCache.fetch(cacheKey, async () => {
		const models: ComparisonPoolModel[] = [];
		const batchSize = 100;
		let offset = 0;

		while (models.length < limit && offset < 5000) {
			try {
				const batch = isCrypto
					? await fetchCryptoLeaderboardBatch(batchSize, offset)
					: await fetchAccountLeaderboardBatch(tournament, batchSize, offset);

				if (batch.length === 0) break;

				for (const entry of batch) {
					if (models.length < limit) models.push(entry);
				}

				if (onProgress) {
					onProgress(Math.min(models.length, limit), limit);
				}

				offset += batchSize;
				await sleep(RATE_LIMIT.minDelayMs);

				if (batch.length < batchSize) break;
			} catch (error) {
				console.error(`Error fetching comparison pool at offset ${offset}:`, error);
				break;
			}
		}

		return models.slice(0, limit);
	});
}

/**
 * Calculate rankings for selected models across rounds
 * This fetches performance data and calculates rankings based on the custom score
 */
export async function calculateModelRankings(
	selectedModels: ModelRef[],
	startRound: number,
	endRound: number,
	formula: ScoreFormula,
	tournament: number = 8,
	onProgress?: (stage: string, loaded: number, total: number) => void
): Promise<ModelRankingHistory[]> {
	if (selectedModels.length === 0) {
		return [];
	}

	const isCrypto = tournament === CRYPTO_TOURNAMENT;

	// Step 1: Fetch comparison pool from the leaderboard
	if (onProgress) onProgress('Fetching comparison pool', 0, 1);

	const poolModels = await fetchComparisonPoolModels(tournament, DEFAULT_COMPARISON_POOL_SIZE, (loaded, total) => {
		if (onProgress) onProgress('Fetching comparison pool', loaded, total);
	});

	// Combine the comparison pool with the selected models, deduped by name.
	// Selected models take precedence so their ids/usernames are preserved.
	const refsByName = new Map<string, ModelRef>();
	for (const m of poolModels) {
		refsByName.set(m.modelName.toLowerCase(), m);
	}
	for (const m of selectedModels) {
		refsByName.set(m.modelName.toLowerCase(), m);
	}

	// Step 2: Fetch performance data for all models
	if (onProgress) onProgress('Fetching model performance', 0, refsByName.size);

	const performanceData = await fetchModelsRoundPerformance(
		Array.from(refsByName.values()),
		tournament,
		(loaded, total) => {
			if (onProgress) onProgress('Fetching model performance', loaded, total);
		}
	);

	// Step 3: Calculate rankings for each round
	if (onProgress) onProgress('Calculating rankings', 0, endRound - startRound + 1);

	const selectedModelsLower = selectedModels.map(m => m.modelName.toLowerCase());
	const rankingHistories: Map<string, ModelRankingHistory> = new Map();

	// Initialize ranking histories for selected models
	for (const { modelName } of selectedModels) {
		const modelData = performanceData.get(modelName.toLowerCase());
		if (modelData && modelData.length > 0) {
			rankingHistories.set(modelName.toLowerCase(), {
				modelId: modelData[0].modelId,
				modelName: modelData[0].modelName,
				username: modelData[0].username,
				rankings: []
			});
		}
	}

	// Process each round
	for (let round = startRound; round <= endRound; round++) {
		// Collect all scores for this round
		const roundScores: Array<{ modelName: string; score: number }> = [];

		for (const [modelNameLower, rounds] of performanceData) {
			const roundData = rounds.find(r => r.roundNumber === round);
			// Crypto has no stake data, so rank every participating model;
			// Classic/Signals only rank staked models.
			if (roundData && (isCrypto || (roundData.stakeValue !== null && roundData.stakeValue > 0))) {
				const score = calculateCustomScore(
					roundData.corr,
					roundData.mmc,
					roundData.tc,
					formula
				);
				if (score !== null) {
					roundScores.push({ modelName: modelNameLower, score });
				}
			}
		}

		// Sort by score descending (higher is better)
		roundScores.sort((a, b) => b.score - a.score);

		// Assign ranks and update histories for selected models
		for (const modelNameLower of selectedModelsLower) {
			const history = rankingHistories.get(modelNameLower);
			if (!history) continue;

			const rankIndex = roundScores.findIndex(s => s.modelName === modelNameLower);
			const modelRoundData = performanceData.get(modelNameLower)?.find(r => r.roundNumber === round);

			if (rankIndex >= 0) {
				history.rankings.push({
					roundNumber: round,
					rank: rankIndex + 1, // 1-indexed rank
					customScore: roundScores[rankIndex].score,
					totalModels: roundScores.length
				});
			} else if (modelRoundData) {
				// Model participated but might not have been staked
				const score = calculateCustomScore(
					modelRoundData.corr,
					modelRoundData.mmc,
					modelRoundData.tc,
					formula
				);
				history.rankings.push({
					roundNumber: round,
					rank: null,
					customScore: score,
					totalModels: roundScores.length
				});
			}
		}

		if (onProgress) {
			onProgress('Calculating rankings', round - startRound + 1, endRound - startRound + 1);
		}
	}

	return Array.from(rankingHistories.values());
}

/**
 * Get top 10 models by custom score for a specific round
 */
export async function getTopModelsForRound(
	roundNumber: number,
	formula: ScoreFormula,
	tournament: number = 8,
	limit: number = 10
): Promise<RoundModelScore[]> {
	const isCrypto = tournament === CRYPTO_TOURNAMENT;

	// Fetch the comparison pool from the leaderboard (ComparisonPoolModel
	// satisfies ModelRef, so it can be passed straight through).
	const poolModels = await fetchComparisonPoolModels(tournament, DEFAULT_COMPARISON_POOL_SIZE);

	// Fetch performance data
	const performanceData = await fetchModelsRoundPerformance(poolModels, tournament);

	// Calculate scores and sort
	const scores: RoundModelScore[] = [];

	for (const [, rounds] of performanceData) {
		const roundData = rounds.find(r => r.roundNumber === roundNumber);
		// Crypto has no stake data, so include every participating model.
		if (roundData && (isCrypto || (roundData.stakeValue !== null && roundData.stakeValue > 0))) {
			const score = calculateCustomScore(
				roundData.corr,
				roundData.mmc,
				roundData.tc,
				formula
			);
			scores.push({
				...roundData,
				customScore: score,
				rank: null
			});
		}
	}

	// Sort by custom score descending
	scores.sort((a, b) => (b.customScore ?? -Infinity) - (a.customScore ?? -Infinity));

	// Assign ranks
	return scores.slice(0, limit).map((s, i) => ({
		...s,
		rank: i + 1
	}));
}
