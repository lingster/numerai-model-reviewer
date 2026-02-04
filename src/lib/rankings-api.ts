/**
 * Rankings API - Functions for fetching round leaderboard data
 * Used to calculate model rankings based on custom score formulas
 */
import type { RoundLeaderboard, RoundModelScore, ScoreFormula, ModelRankingHistory } from '$lib/types.js';
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
 * Fetch staked models for a specific round from the leaderboard
 * Uses paginated leaderboard API to get all staked models
 */
export async function fetchRoundLeaderboard(
	roundNumber: number,
	tournament: number = 8,
	onProgress?: (loaded: number, total: number) => void
): Promise<RoundLeaderboard> {
	const cacheKey = `round-leaderboard:r${roundNumber}:t${tournament}`;

	// Check cache first
	const cached = swrCache.get<RoundLeaderboard>(cacheKey);
	if (cached.data && !cached.isStale) {
		return cached.data;
	}

	return swrCache.fetch(cacheKey, async () => {
		const models: RoundModelScore[] = [];
		const batchSize = 500;
		let offset = 0;
		let totalFetched = 0;
		const maxModels = 10000; // Safety limit

		while (offset < maxModels) {
			try {
				// For Classic/Signals tournaments, use v3 API with round-specific performance
				const result = await query<{
					accountLeaderboard: Array<{
						id: string;
						username: string;
						models: Array<{
							id: string;
							displayName: string;
							tournament: number;
						}> | null;
					}>;
				}>(`
					query getLeaderboardModels($limit: Int!, $offset: Int!, $tournament: Int!) {
						accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
							id
							username
							models {
								id
								displayName
								tournament
							}
						}
					}
				`, { limit: batchSize, offset, tournament });

				const batch = result.accountLeaderboard;
				if (!batch || batch.length === 0) break;

				// Collect all models from this batch
				for (const account of batch) {
					if (account.models) {
						for (const model of account.models) {
							if (model.tournament === tournament) {
								models.push({
									modelId: model.id,
									modelName: model.displayName,
									username: account.username,
									roundNumber,
									corr: null,
									mmc: null,
									tc: null,
									stakeValue: null,
									customScore: null,
									rank: null
								});
							}
						}
					}
				}

				totalFetched += batch.length;
				if (onProgress) {
					onProgress(totalFetched, maxModels);
				}

				offset += batchSize;

				// Rate limiting
				await sleep(RATE_LIMIT.minDelayMs);

				if (batch.length < batchSize) break;
			} catch (error) {
				console.error(`Error fetching leaderboard at offset ${offset}:`, error);
				break;
			}
		}

		return {
			roundNumber,
			tournament,
			models,
			fetchedAt: Date.now()
		};
	});
}

/**
 * Fetch performance data for multiple models for a specific round
 * This is the main function used to get ranking data
 */
export async function fetchModelsRoundPerformance(
	modelNames: string[],
	tournament: number = 8,
	onProgress?: (loaded: number, total: number) => void
): Promise<Map<string, RoundModelScore[]>> {
	const results = new Map<string, RoundModelScore[]>();
	const total = modelNames.length;
	let loaded = 0;

	// Process models in batches to respect rate limits
	const batchSize = 5;

	for (let i = 0; i < modelNames.length; i += batchSize) {
		const batch = modelNames.slice(i, i + batchSize);

		// Fetch batch in parallel
		const batchPromises = batch.map(async (modelName) => {
			const cacheKey = `model-rounds:${modelName.toLowerCase()}:t${tournament}`;

			const cached = swrCache.get<RoundModelScore[]>(cacheKey);
			if (cached.data && !cached.isStale) {
				return { modelName, data: cached.data };
			}

			try {
				const data = await swrCache.fetch(cacheKey, async () => {
					const result = await query<{
						v3UserProfile: {
							id: string;
							username: string;
							accountName: string;
							roundModelPerformances: Array<{
								roundNumber: number;
								corr: number | null;
								corr20V2: number | null;
								mmc: number | null;
								tc: number | null;
								selectedStakeValue: number | null;
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
							corr: r.corr20V2 ?? r.corr,
							mmc: r.mmc,
							tc: r.tc,
							stakeValue: r.selectedStakeValue,
							customScore: null,
							rank: null
						}));
				});

				return { modelName, data };
			} catch (error) {
				console.error(`Error fetching performance for ${modelName}:`, error);
				return { modelName, data: [] };
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

		// Rate limiting between batches
		if (i + batchSize < modelNames.length) {
			await sleep(RATE_LIMIT.minDelayMs);
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

/**
 * Fetch top staked models from leaderboard
 * Returns models with the highest stake values
 */
export async function fetchTopStakedModels(
	tournament: number = 8,
	limit: number = 500,
	onProgress?: (loaded: number, total: number) => void
): Promise<Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>> {
	const cacheKey = `top-staked:t${tournament}:l${limit}`;

	const cached = swrCache.get<Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>>(cacheKey);
	if (cached.data && !cached.isStale) {
		return cached.data;
	}

	return swrCache.fetch(cacheKey, async () => {
		const models: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }> = [];
		const batchSize = 100;
		let offset = 0;

		while (models.length < limit && offset < 5000) {
			try {
				const result = await query<{
					accountLeaderboard: Array<{
						id: string;
						username: string;
						models: Array<{
							id: string;
							displayName: string;
							tournament: number;
						}> | null;
					}>;
				}>(`
					query getTopStakedModels($limit: Int!, $offset: Int!, $tournament: Int!) {
						accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
							id
							username
							models {
								id
								displayName
								tournament
							}
						}
					}
				`, { limit: batchSize, offset, tournament });

				const batch = result.accountLeaderboard;
				if (!batch || batch.length === 0) break;

				for (const account of batch) {
					if (account.models) {
						for (const model of account.models) {
							if (model.tournament === tournament && models.length < limit) {
								models.push({
									modelId: model.id,
									modelName: model.displayName,
									username: account.username,
									stakeValue: 0 // Will be populated when fetching performance
								});
							}
						}
					}
				}

				if (onProgress) {
					onProgress(Math.min(models.length, limit), limit);
				}

				offset += batchSize;
				await sleep(RATE_LIMIT.minDelayMs);

				if (batch.length < batchSize) break;
			} catch (error) {
				console.error(`Error fetching top staked models at offset ${offset}:`, error);
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
	selectedModelNames: string[],
	startRound: number,
	endRound: number,
	formula: ScoreFormula,
	tournament: number = 8,
	onProgress?: (stage: string, loaded: number, total: number) => void
): Promise<ModelRankingHistory[]> {
	if (selectedModelNames.length === 0) {
		return [];
	}

	// Step 1: Fetch top staked models for comparison pool
	if (onProgress) onProgress('Fetching top staked models', 0, 1);

	const topModels = await fetchTopStakedModels(tournament, 500, (loaded, total) => {
		if (onProgress) onProgress('Fetching top staked models', loaded, total);
	});

	// Ensure selected models are included
	const allModelNames = new Set(topModels.map(m => m.modelName.toLowerCase()));
	for (const name of selectedModelNames) {
		allModelNames.add(name.toLowerCase());
	}

	// Step 2: Fetch performance data for all models
	if (onProgress) onProgress('Fetching model performance', 0, allModelNames.size);

	const performanceData = await fetchModelsRoundPerformance(
		Array.from(allModelNames),
		tournament,
		(loaded, total) => {
			if (onProgress) onProgress('Fetching model performance', loaded, total);
		}
	);

	// Step 3: Calculate rankings for each round
	if (onProgress) onProgress('Calculating rankings', 0, endRound - startRound + 1);

	const selectedModelsLower = selectedModelNames.map(n => n.toLowerCase());
	const rankingHistories: Map<string, ModelRankingHistory> = new Map();

	// Initialize ranking histories for selected models
	for (const modelName of selectedModelNames) {
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
			if (roundData && roundData.stakeValue !== null && roundData.stakeValue > 0) {
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
	// Fetch top staked models
	const topModels = await fetchTopStakedModels(tournament, 500);

	// Fetch performance data
	const performanceData = await fetchModelsRoundPerformance(
		topModels.map(m => m.modelName),
		tournament
	);

	// Calculate scores and sort
	const scores: RoundModelScore[] = [];

	for (const [modelNameLower, rounds] of performanceData) {
		const roundData = rounds.find(r => r.roundNumber === roundNumber);
		if (roundData && roundData.stakeValue !== null && roundData.stakeValue > 0) {
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
