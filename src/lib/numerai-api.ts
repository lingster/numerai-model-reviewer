/**
 * Numerai API client
 * Uses Cloudflare Worker backend proxy for all API calls
 * Credentials are handled server-side only
 * Includes SWR caching for improved performance
 */
import type { NumeraiUser, NumeraiModel, ModelPerformance, RoundPerformance } from '$lib/types.js';
import { config } from '$lib/config.js';
import { swrCache, cacheKeys } from '$lib/utils/swr-cache.svelte.js';

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

/**
 * NumeraiAPI class for interacting with the Numerai tournament API
 * All requests go through the Cloudflare Worker backend proxy
 * Uses SWR caching for improved performance
 */
export class NumeraiAPI {
	private userCache: Map<string, NumeraiUser[]> = new Map();
	private apiUrl: string;

	constructor() {
		this.apiUrl = config.apiUrl;
	}

	/**
	 * Execute a GraphQL query against the backend proxy
	 */
	private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
		const response = await fetch(`${this.apiUrl}/graphql`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				query,
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
	 * Search for users by username with SWR caching
	 * Uses a hybrid approach (prioritizing username matches):
	 * 1. Direct accountProfile lookup for exact matches
	 * 2. Paginated leaderboard search for partial username matches
	 * 3. Model name lookup (last) - only if we need more results
	 */
	async searchUsers(searchQuery: string): Promise<NumeraiUser[]> {
		const cacheKey = cacheKeys.userSearch(searchQuery);

		// Try to get from SWR cache first
		const cached = swrCache.get<NumeraiUser[]>(cacheKey);
		if (cached.data && !cached.isStale) {
			return cached.data;
		}

		// Fetch with SWR deduplication
		return swrCache.fetch(cacheKey, async () => {
			return this.fetchUsers(searchQuery);
		});
	}

	/**
	 * Internal method to fetch users (called by SWR)
	 */
	private async fetchUsers(searchQuery: string): Promise<NumeraiUser[]> {
		const users: NumeraiUser[] = [];
		const { batchSize, maxUsers, targetResults } = config.search;
		const searchLower = searchQuery.toLowerCase();

		// 1. First try direct user lookup via accountProfile (exact match)
		const accountQuery = `
			query searchUserByAccount($username: String!) {
				accountProfile(username: $username) {
					id
					username
				}
			}
		`;

		try {
			const accountResult = await this.query<{
				accountProfile: { id: string; username: string } | null;
			}>(accountQuery, { username: searchQuery });

			if (accountResult.accountProfile) {
				users.push({
					id: accountResult.accountProfile.id,
					username: accountResult.accountProfile.username
				});
			}
		} catch {
			// If direct lookup fails, continue to other methods
		}

		// 2. Paginated account leaderboard search for partial username matches
		let offset = 0;

		while (users.length < targetResults && offset < maxUsers) {
			try {
				const leaderboardResult = await this.query<{
					accountLeaderboard: Array<{ id: string; username: string }>;
				}>(
					`query accountLeaderboardSearch($limit: Int!, $offset: Int!) {
						accountLeaderboard(limit: $limit, offset: $offset) {
							id
							username
						}
					}`,
					{ limit: batchSize, offset }
				);

				const batch = leaderboardResult.accountLeaderboard;

				if (batch.length === 0) {
					break;
				}

				for (const entry of batch) {
					if (entry.username.toLowerCase().includes(searchLower)) {
						if (!users.find((u) => u.username.toLowerCase() === entry.username.toLowerCase())) {
							users.push({
								id: entry.id,
								username: entry.username
							});

							if (users.length >= targetResults) {
								break;
							}
						}
					}
				}

				offset += batchSize;

				if (batch.length < batchSize) {
					break;
				}
			} catch (error) {
				console.error('Error searching leaderboard at offset', offset, ':', error);
				break;
			}
		}

		// 3. Model name lookup (last resort)
		if (users.length < targetResults) {
			const modelQuery = `
				query searchUserByModel($modelName: String!) {
					v3UserProfile(modelName: $modelName) {
						id
						accountName
					}
				}
			`;

			try {
				const modelResult = await this.query<{
					v3UserProfile: { id: string; accountName: string } | null;
				}>(modelQuery, { modelName: searchQuery });

				if (modelResult.v3UserProfile && modelResult.v3UserProfile.accountName) {
					const accountName = modelResult.v3UserProfile.accountName;
					if (!users.find((u) => u.username.toLowerCase() === accountName.toLowerCase())) {
						users.push({
							id: accountName,
							username: accountName
						});
					}
				}
			} catch {
				// If model lookup fails, we're done
			}
		}

		// Also update legacy cache for backward compatibility
		this.userCache.set(searchQuery.toLowerCase(), users);
		return users;
	}

	/**
	 * Get all models for a specific user with SWR caching
	 * @param username The username to get models for
	 * @param tournament Optional tournament ID (8=Classic, 11=Signals, 12=Crypto)
	 */
	async getUserModels(username: string, tournament?: number): Promise<NumeraiModel[]> {
		const cacheKey = tournament
			? `${cacheKeys.userModels(username)}:t${tournament}`
			: cacheKeys.userModels(username);

		// Try SWR cache first
		const cached = swrCache.get<NumeraiModel[]>(cacheKey);
		if (cached.data && !cached.isStale) {
			return cached.data;
		}

		// Fetch with SWR deduplication
		return swrCache.fetch(cacheKey, async () => {
			return this.fetchUserModels(username, tournament);
		});
	}

	/**
	 * Internal method to fetch user models (called by SWR)
	 * @param username The username to get models for
	 * @param tournament Optional tournament ID - required for Crypto (12) to return models
	 */
	private async fetchUserModels(username: string, tournament?: number): Promise<NumeraiModel[]> {
		// Use tournament-specific query if tournament is provided (required for Crypto)
		const accountQuery = tournament
			? `
				query getUserModels($username: String!, $tournament: Int!) {
					accountProfile(username: $username, tournament: $tournament) {
						id
						username
						models {
							id
							displayName
							tournament
						}
					}
				}
			`
			: `
				query getUserModels($username: String!) {
					accountProfile(username: $username) {
						id
						username
						models {
							id
							displayName
							tournament
						}
					}
				}
			`;

		const variables = tournament ? { username, tournament } : { username };

		try {
			const result = await this.query<{
				accountProfile: {
					id: string;
					username: string;
					models: Array<{ id: string; displayName: string; tournament: number }> | null;
				} | null;
			}>(accountQuery, variables);

			if (result.accountProfile) {
				const models = result.accountProfile.models || [];
				return models.map((model) => ({
					id: model.id,
					name: model.displayName,
					username: result.accountProfile!.username,
					tournament: model.tournament
				}));
			}
		} catch (error) {
			console.error('Error with accountProfile query:', error);
		}

		// Fallback: Try looking up as a model name (only for non-Crypto tournaments)
		// v3UserProfile doesn't work for Crypto models
		if (tournament !== 12) {
			const modelQuery = `
				query getModelByName($modelName: String!) {
					v3UserProfile(modelName: $modelName) {
						id
						username
						accountName
					}
				}
			`;

			try {
				const modelResult = await this.query<{
					v3UserProfile: {
						id: string;
						username: string;
						accountName: string;
					} | null;
				}>(modelQuery, { modelName: username });

				if (modelResult.v3UserProfile && modelResult.v3UserProfile.accountName) {
					const accountOwner = modelResult.v3UserProfile.accountName;
					console.log(`Input "${username}" is a model name, fetching models for account: ${accountOwner}`);

					if (accountOwner.toLowerCase() !== username.toLowerCase()) {
						return this.getUserModels(accountOwner, tournament);
					}

					return [{
						id: modelResult.v3UserProfile.id,
						name: modelResult.v3UserProfile.username,
						username: modelResult.v3UserProfile.accountName,
						tournament: 8
					}];
				}
			} catch (error) {
				console.error('Error looking up as model name:', error);
			}
		}

		return [];
	}

	/**
	 * Get models by searching for a model name directly
	 */
	private async getModelsByName(modelName: string): Promise<NumeraiModel[]> {
		const query = `
			query getModel($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					id
					username
					accountName
					tournament
				}
			}
		`;

		try {
			const result = await this.query<{
				v3UserProfile: {
					id: string;
					username: string;
					accountName: string;
					tournament: number;
				} | null;
			}>(query, { modelName });

			if (!result.v3UserProfile) {
				return [];
			}

			return [{
				id: result.v3UserProfile.id,
				name: result.v3UserProfile.username,
				username: result.v3UserProfile.accountName,
				tournament: result.v3UserProfile.tournament
			}];
		} catch (error) {
			console.error('Error getting models by name:', error);
			return [];
		}
	}

	/**
	 * Get model performance data from model objects with parallel fetching
	 */
	async getModelPerformanceFromModels(models: NumeraiModel[]): Promise<ModelPerformance[]> {
		// Fetch all performances in parallel with SWR caching
		const promises = models.map(async (model) => {
			try {
				return await this.getModelPerformance(model.name, model.username, model.id, model.tournament);
			} catch (error) {
				console.error(`Error getting performance for model ${model.name}:`, error);
				return null;
			}
		});

		const results = await Promise.all(promises);
		return results.filter((r): r is ModelPerformance => r !== null);
	}

	/**
	 * Get performance data for a single model with SWR caching
	 * @param modelName The model name
	 * @param username The username who owns the model
	 * @param modelId The model UUID (required for Crypto)
	 * @param tournament The tournament ID (12 = Crypto requires different API)
	 */
	private async getModelPerformance(
		modelName: string,
		username: string,
		modelId?: string,
		tournament?: number
	): Promise<ModelPerformance | null> {
		const cacheKey = tournament
			? `${cacheKeys.modelPerformance(modelName)}:t${tournament}`
			: cacheKeys.modelPerformance(modelName);

		// Try SWR cache first
		const cached = swrCache.get<ModelPerformance>(cacheKey);
		if (cached.data && !cached.isStale) {
			return cached.data;
		}

		// Fetch with SWR deduplication
		return swrCache.fetch(cacheKey, async () => {
			// Use Crypto-specific API for tournament 12
			if (tournament === 12 && modelId) {
				return this.fetchCryptoModelPerformance(modelName, username, modelId, tournament);
			}
			return this.fetchModelPerformance(modelName, username);
		});
	}

	/**
	 * Internal method to fetch model performance (called by SWR)
	 */
	private async fetchModelPerformance(
		modelName: string,
		_username: string
	): Promise<ModelPerformance | null> {
		const toNumber = (value: number | string | null | undefined): number | null => {
			if (value === null || value === undefined) return null;
			if (typeof value === 'number') return Number.isFinite(value) ? value : null;
			if (typeof value === 'string') {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		};

		const query = `
			query getModelPerformance($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					id
					username
					accountName
					stakeValue
					stakeInfo {
						corrMultiplier
						mmcMultiplier
						tcMultiplier
					}
					roundModelPerformances {
						roundNumber
						roundOpenTime
						roundResolveTime
						roundResolved
						corr
						corr20V2
						corr60
						corrPercentile
						corr20V2Percentile
						mmc
						mmcPercentile
						tc
						tcPercentile
						fnc
						fncV3
						fncV4
						corrMultiplier
						mmcMultiplier
						tcMultiplier
						selectedStakeValue
						payout
						roundPayoutFactor
					}
				}
			}
		`;

		try {
			const result = await this.query<{
				v3UserProfile: {
					id: string;
					username: string;
					accountName: string;
					stakeValue?: number;
					stakeInfo?: {
						corrMultiplier?: number;
						mmcMultiplier?: number;
						tcMultiplier?: number;
					};
					roundModelPerformances: Array<{
						roundNumber: number;
						roundOpenTime?: string;
						roundResolveTime?: string;
						roundResolved?: boolean;
						corr?: number;
						corr20V2?: number;
						corr60?: number;
						corrPercentile?: number;
						corr20V2Percentile?: number;
						mmc?: number;
						mmcPercentile?: number;
						tc?: number;
						tcPercentile?: number;
						fnc?: number;
						fncV3?: number;
						fncV4?: number;
						corrMultiplier?: number;
						mmcMultiplier?: number;
						tcMultiplier?: number;
						selectedStakeValue?: number;
						payout?: number;
						roundPayoutFactor?: string;
					}>;
				} | null;
			}>(query, { modelName });

			if (!result.v3UserProfile) {
				return null;
			}

			// Use all available rounds - date filtering is handled by TimeSeriesChart
			const rounds: RoundPerformance[] = result.v3UserProfile.roundModelPerformances.map((round) => {
				const resolved = round.roundResolved ?? Boolean(round.roundResolveTime);

				return {
					roundNumber: round.roundNumber,
					roundOpenTime: round.roundOpenTime,
					roundResolveTime: round.roundResolveTime,
					roundResolved: resolved,
					correlation: toNumber(round.corr20V2 ?? round.corr),
					corr60: toNumber(round.corr60),
					mmc: toNumber(round.mmc),
					fnc: toNumber(round.fncV4 ?? round.fncV3 ?? round.fnc),
					tc: toNumber(round.tc),
					corrMultiplier: toNumber(round.corrMultiplier),
					mmcMultiplier: toNumber(round.mmcMultiplier),
					selectedStakeValue: toNumber(round.selectedStakeValue),
					payout: toNumber(round.payout)
				};
			});

			return {
				modelId: result.v3UserProfile.id,
				modelName: result.v3UserProfile.username,
				username: result.v3UserProfile.accountName,
				stakeValue: toNumber(result.v3UserProfile.stakeValue),
				stakeInfo: result.v3UserProfile.stakeInfo ? {
					corrMultiplier: toNumber(result.v3UserProfile.stakeInfo.corrMultiplier),
					mmcMultiplier: toNumber(result.v3UserProfile.stakeInfo.mmcMultiplier),
					tcMultiplier: toNumber(result.v3UserProfile.stakeInfo.tcMultiplier)
				} : null,
				rounds
			};
		} catch (error) {
			console.error(`Error getting performance for ${modelName}:`, error);
			return null;
		}
	}

	/**
	 * Fetch performance data for Crypto tournament models
	 * Uses v2RoundModelPerformances API which is required for Crypto
	 */
	private async fetchCryptoModelPerformance(
		modelName: string,
		username: string,
		modelId: string,
		tournament: number
	): Promise<ModelPerformance | null> {
		const toNumber = (value: number | string | null | undefined): number | null => {
			if (value === null || value === undefined) return null;
			if (typeof value === 'number') return Number.isFinite(value) ? value : null;
			if (typeof value === 'string') {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		};

		const query = `
			query getCryptoModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundOpenTime
					roundResolveTime
					roundResolved
					submissionScores {
						displayName
						value
					}
				}
			}
		`;

		try {
			const result = await this.query<{
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
			}>(query, { modelId, tournament, lastNRounds: 100 });

			if (!result.v2RoundModelPerformances || result.v2RoundModelPerformances.length === 0) {
				return null;
			}

			// Map Crypto performance data to standard RoundPerformance format
			const rounds: RoundPerformance[] = result.v2RoundModelPerformances.map((round) => {
				const scores = round.submissionScores || [];
				const getScore = (name: string): number | null => {
					const score = scores.find((s) => s.displayName === name);
					return score ? toNumber(score.value) : null;
				};

				return {
					roundNumber: round.roundNumber,
					roundOpenTime: round.roundOpenTime ?? undefined,
					roundResolveTime: round.roundResolveTime ?? undefined,
					roundResolved: round.roundResolved ?? false,
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
		} catch (error) {
			console.error(`Error getting Crypto performance for ${modelName}:`, error);
			return null;
		}
	}

	/**
	 * Get models by their names with SWR caching
	 * @param modelNames Array of model names to look up
	 * @param tournament Optional tournament ID - required for Crypto (12) models
	 */
	async getModelsByNames(modelNames: string[], tournament?: number): Promise<NumeraiModel[]> {
		// Fetch all models in parallel with SWR caching
		const promises = modelNames.map(async (modelName) => {
			const cacheKey = tournament
				? `model-by-name:${modelName.toLowerCase()}:t${tournament}`
				: `model-by-name:${modelName.toLowerCase()}`;

			// Try cache first
			const cached = swrCache.get<NumeraiModel>(cacheKey);
			if (cached.data && !cached.isStale) {
				return cached.data;
			}

			return swrCache.fetch(cacheKey, async () => {
				// For Crypto tournament, we need to search via accountProfile
				// since v3UserProfile doesn't work for Crypto models
				if (tournament === 12) {
					return this.findCryptoModelByName(modelName, tournament);
				}

				// For Classic/Signals, use v3UserProfile
				const query = `
					query getModelByName($modelName: String!) {
						v3UserProfile(modelName: $modelName) {
							id
							username
							accountName
							tournament
						}
					}
				`;

				try {
					const result = await this.query<{
						v3UserProfile: {
							id: string;
							username: string;
							accountName: string;
							tournament: number;
						} | null;
					}>(query, { modelName });

					if (result.v3UserProfile) {
						return {
							id: result.v3UserProfile.id,
							name: result.v3UserProfile.username,
							username: result.v3UserProfile.accountName,
							tournament: result.v3UserProfile.tournament
						};
					}
				} catch (error) {
					console.error(`Error getting model by name ${modelName}:`, error);
				}
				return null;
			});
		});

		const results = await Promise.all(promises);
		return results.filter((r): r is NumeraiModel => r !== null);
	}

	/**
	 * Find a Crypto model by searching the leaderboard for users with that model name
	 * This is needed because v3UserProfile doesn't work for Crypto models
	 */
	private async findCryptoModelByName(modelName: string, tournament: number): Promise<NumeraiModel | null> {
		// First, try to find the model by searching for users in the leaderboard
		// and checking if they have a model with this name
		const batchSize = 500;
		const maxSearchUsers = 2000;
		let offset = 0;

		while (offset < maxSearchUsers) {
			try {
				const leaderboardResult = await this.query<{
					accountLeaderboard: Array<{ id: string; username: string }>;
				}>(
					`query accountLeaderboardSearch($limit: Int!, $offset: Int!, $tournament: Int!) {
						accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
							id
							username
						}
					}`,
					{ limit: batchSize, offset, tournament }
				);

				const batch = leaderboardResult.accountLeaderboard;
				if (batch.length === 0) break;

				// Check each user for the model
				for (const user of batch) {
					const userModels = await this.fetchUserModels(user.username, tournament);
					const model = userModels.find(
						(m) => m.name.toLowerCase() === modelName.toLowerCase()
					);
					if (model) {
						return model;
					}
				}

				offset += batchSize;
				if (batch.length < batchSize) break;
			} catch (error) {
				console.error('Error searching for Crypto model:', error);
				break;
			}
		}

		return null;
	}

	/**
	 * Clear the user search cache (both legacy and SWR)
	 */
	clearUserCache(): void {
		this.userCache.clear();
		swrCache.invalidatePattern(/^user-search:/);
	}

	/**
	 * Clear all SWR caches
	 */
	clearAllCaches(): void {
		this.userCache.clear();
		swrCache.clear();
	}

	/**
	 * Invalidate specific model's cached data
	 */
	invalidateModel(modelName: string): void {
		swrCache.invalidate(cacheKeys.modelPerformance(modelName));
	}

	/**
	 * Invalidate specific user's cached data
	 */
	invalidateUser(username: string): void {
		swrCache.invalidate(cacheKeys.userModels(username));
		swrCache.invalidate(cacheKeys.accountProfile(username));
	}

	/**
	 * Get cache statistics for debugging
	 */
	getCacheStats(): { swr: { size: number; keys: string[] }; legacy: number } {
		return {
			swr: swrCache.stats(),
			legacy: this.userCache.size
		};
	}
}
