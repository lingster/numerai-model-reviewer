/**
 * Numerai API client
 * Uses Cloudflare Worker backend proxy for all API calls
 * Credentials are handled server-side only
 * Includes SWR caching for improved performance
 */
import type { NumeraiUser, NumeraiModel, ModelPerformance } from '$lib/types.js';
import { config } from '$lib/config.js';
import { swrCache, cacheKeys } from '$lib/utils/swr-cache.svelte.js';

/**
 * NumeraiAPI class for interacting with the Numerai tournament API via the Worker Proxy
 * All requests go through the Cloudflare Worker backend proxy which now handles GraphQL generation
 * Uses SWR caching for improved performance
 */
export class NumeraiAPI {
	private userCache: Map<string, NumeraiUser[]> = new Map();
	private apiUrl: string;

	constructor() {
		this.apiUrl = config.apiUrl;
	}

	/**
	 * Generic fetch wrapper for the Worker REST API
	 */
	private async fetchApi<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
		const url = new URL(`${this.apiUrl}${path}`);
		if (params) {
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined) {
					url.searchParams.append(key, String(value));
				}
			});
		}

		const response = await fetch(url.toString(), {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			if (response.status === 404) {
				// Return null for 404s if expected, but generally throw to let caller handle
				throw new Error('Not found');
			}
			throw new Error(`API request failed: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Search for users by username with SWR caching
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
			const users = await this.fetchApi<NumeraiUser[]>('/search/users', {
				q: searchQuery,
				limit: config.search.targetResults // Pass limit from config
			});
			// Also update legacy cache for backward compatibility
			this.userCache.set(searchQuery.toLowerCase(), users);
			return users;
		});
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
			return this.fetchApi<NumeraiModel[]>(`/users/${username}/models`, {
				tournament
			});
		});
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
			try {
				return await this.fetchApi<ModelPerformance>(`/models/${modelName}/performance`, {
					username,
					modelId,
					tournament
				});
			} catch (e) {
				console.error(`Error fetching performance for ${modelName}:`, e);
				return null;
			}
		});
	}

	/**
	 * Get models by their names with SWR caching
	 * @param modelNames Array of model names to look up
	 * @param tournament Optional tournament ID - required for Crypto (12) models
	 * @param username Optional owning account. For Crypto this lets the worker
	 *   resolve the model via a single getUserModels call instead of scanning
	 *   the leaderboard (avoids the N+1).
	 */
	async getModelsByNames(
		modelNames: string[],
		tournament?: number,
		username?: string
	): Promise<NumeraiModel[]> {
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
				try {
					return await this.fetchApi<NumeraiModel>(`/models/${modelName}`, {
						tournament,
						username
					});
				} catch (e) {
					console.error(`Error fetching model by name ${modelName}:`, e);
					return null;
				}
			});
		});

		const results = await Promise.all(promises);
		return results.filter((r): r is NumeraiModel => r !== null);
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