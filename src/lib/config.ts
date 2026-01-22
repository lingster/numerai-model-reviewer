/**
 * Application configuration
 * Uses environment variables for flexibility across environments
 */

/**
 * API URL configuration
 * - Development: http://localhost:8787 (local Cloudflare Worker)
 * - Production: https://numerdiff-api.imperialai.ai (deployed Worker)
 */
const getApiUrl = (): string => {
	// Use environment variable if set
	if (import.meta.env.VITE_API_URL) {
		return import.meta.env.VITE_API_URL;
	}
	// In production (non-dev mode), use production API
	if (import.meta.env.PROD) {
		return 'https://numerdiff-api.imperialai.ai';
	}
	// Default to localhost for development
	return 'http://localhost:8787';
};

/**
 * User search configuration
 * Controls how the leaderboard is searched for partial username matches
 */
const getSearchConfig = () => {
	const batchSize = parseInt(import.meta.env.VITE_SEARCH_BATCH_SIZE || '500', 10);
	const maxUsers = parseInt(import.meta.env.VITE_SEARCH_MAX_USERS || '5000', 10);
	const targetResults = parseInt(import.meta.env.VITE_SEARCH_TARGET_RESULTS || '20', 10);

	return {
		// Number of users to fetch per API call
		batchSize,
		// Maximum total users to search through
		maxUsers,
		// Stop searching once we have this many matches
		targetResults
	};
};

export const config = {
	apiUrl: getApiUrl(),
	search: getSearchConfig()
};
