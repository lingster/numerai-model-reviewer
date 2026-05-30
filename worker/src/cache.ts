/**
 * D1 Cache Helpers
 * Provides get/set operations with TTL support for the graphql_cache table
 */

/**
 * Get a cached response from D1
 * Returns null if not found or expired
 */
export async function getCached(db: D1Database, key: string): Promise<string | null> {
	const now = Math.floor(Date.now() / 1000);
	const row = await db.prepare(
		'SELECT response_data, created_at, ttl_seconds FROM graphql_cache WHERE cache_key = ?'
	).bind(key).first<{ response_data: string; created_at: number; ttl_seconds: number }>();

	if (!row) return null;

	// Check if expired
	if (now - row.created_at > row.ttl_seconds) {
		// Clean up expired entry asynchronously (best-effort)
		await db.prepare('DELETE FROM graphql_cache WHERE cache_key = ?').bind(key).run().catch(() => {});
		return null;
	}

	return row.response_data;
}

/**
 * Store a response in D1 cache
 */
export async function setCached(
	db: D1Database,
	key: string,
	data: string,
	ttlSeconds: number = 86400
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.prepare(
		'INSERT OR REPLACE INTO graphql_cache (cache_key, response_data, created_at, ttl_seconds) VALUES (?, ?, ?, ?)'
	).bind(key, data, now, ttlSeconds).run();
}

/**
 * Determine TTL based on query content
 * - Resolved round data: 24 hours (stable, won't change)
 * - Current/recent round data: 5 minutes (still updating)
 */
export function determineTTL(queryBody: string): number {
	const TTL_LONG = 86400;   // 24 hours for resolved data
	const TTL_SHORT = 300;    // 5 minutes for current data

	// Queries for specific round performance or historical data get long TTL
	if (queryBody.includes('roundModelPerformances') || queryBody.includes('roundResolved')) {
		return TTL_LONG;
	}

	// Leaderboard queries get shorter TTL since stake values change
	if (queryBody.includes('accountLeaderboard')) {
		return TTL_SHORT;
	}

	// Default to short TTL
	return TTL_SHORT;
}

/**
 * Generate a cache key from a GraphQL query and variables
 */
export async function generateCacheKey(query: string, variables?: Record<string, unknown>): Promise<string> {
	const payload = JSON.stringify({ query: query.trim(), variables: variables ?? {} });
	const encoder = new TextEncoder();
	const data = encoder.encode(payload);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return 'gql:' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Clean up expired cache entries
 */
export async function cleanExpiredCache(db: D1Database): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const result = await db.prepare(
		'DELETE FROM graphql_cache WHERE (created_at + ttl_seconds) < ?'
	).bind(now).run();
	return result.meta.changes ?? 0;
}

/**
 * Get cache statistics
 */
export async function getCacheStats(db: D1Database): Promise<{
	totalEntries: number;
	expiredEntries: number;
	totalModels: number;
	totalPerformanceRows: number;
}> {
	const now = Math.floor(Date.now() / 1000);

	const [cacheCount, expiredCount, modelCount, perfCount] = await Promise.all([
		db.prepare('SELECT COUNT(*) as cnt FROM graphql_cache').first<{ cnt: number }>(),
		db.prepare('SELECT COUNT(*) as cnt FROM graphql_cache WHERE (created_at + ttl_seconds) < ?').bind(now).first<{ cnt: number }>(),
		db.prepare('SELECT COUNT(*) as cnt FROM top_staked_models').first<{ cnt: number }>(),
		db.prepare('SELECT COUNT(*) as cnt FROM model_performances').first<{ cnt: number }>()
	]);

	return {
		totalEntries: cacheCount?.cnt ?? 0,
		expiredEntries: expiredCount?.cnt ?? 0,
		totalModels: modelCount?.cnt ?? 0,
		totalPerformanceRows: perfCount?.cnt ?? 0
	};
}
