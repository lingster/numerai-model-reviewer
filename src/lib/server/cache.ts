/**
 * Server-side in-memory cache with TTL support
 * Used to reduce API calls to Numerai backend
 */

interface CacheEntry<T> {
	data: T;
	expires: number;
	staleAt: number;
}

interface CacheConfig {
	/** Default TTL in milliseconds */
	defaultTTL: number;
	/** Stale-while-revalidate window in milliseconds */
	staleWindow: number;
	/** Maximum number of entries (LRU eviction) */
	maxEntries: number;
}

const DEFAULT_CONFIG: CacheConfig = {
	defaultTTL: 5 * 60 * 1000, // 5 minutes
	staleWindow: 60 * 1000, // 1 minute stale-while-revalidate
	maxEntries: 1000
};

/**
 * TTL-based cache configurations by query type
 */
export const CACHE_TTLS = {
	/** User search results - rarely change */
	userSearch: 15 * 60 * 1000, // 15 minutes
	/** Model list for a user - infrequently updated */
	userModels: 10 * 60 * 1000, // 10 minutes
	/** Model performance data - updates per round */
	modelPerformance: 5 * 60 * 1000, // 5 minutes
	/** Account profile lookups */
	accountProfile: 10 * 60 * 1000, // 10 minutes
	/** Leaderboard data */
	leaderboard: 5 * 60 * 1000, // 5 minutes
	/** Default for unknown queries */
	default: 5 * 60 * 1000 // 5 minutes
} as const;

export class ServerCache {
	private cache: Map<string, CacheEntry<unknown>> = new Map();
	private accessOrder: string[] = [];
	private config: CacheConfig;

	constructor(config: Partial<CacheConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Generate a cache key from query and variables
	 */
	static generateKey(query: string, variables?: Record<string, unknown>): string {
		const normalizedQuery = query.replace(/\s+/g, ' ').trim();
		const varsString = variables ? JSON.stringify(variables, Object.keys(variables).sort()) : '';
		return `${normalizedQuery}::${varsString}`;
	}

	/**
	 * Detect query type from GraphQL query string
	 */
	static detectQueryType(query: string): keyof typeof CACHE_TTLS {
		const normalizedQuery = query.toLowerCase();

		if (normalizedQuery.includes('accountleaderboard')) {
			return 'leaderboard';
		}
		if (normalizedQuery.includes('accountprofile')) {
			if (normalizedQuery.includes('models')) {
				return 'userModels';
			}
			return 'accountProfile';
		}
		if (normalizedQuery.includes('v3userprofile')) {
			if (normalizedQuery.includes('roundmodelperformances')) {
				return 'modelPerformance';
			}
			return 'userModels';
		}
		if (normalizedQuery.includes('search')) {
			return 'userSearch';
		}

		return 'default';
	}

	/**
	 * Get item from cache
	 * Returns { data, isStale } if found, null otherwise
	 */
	get<T>(key: string): { data: T; isStale: boolean } | null {
		const entry = this.cache.get(key) as CacheEntry<T> | undefined;
		if (!entry) return null;

		const now = Date.now();

		// Expired and past stale window - remove and return null
		if (now > entry.expires + this.config.staleWindow) {
			this.cache.delete(key);
			this.removeFromAccessOrder(key);
			return null;
		}

		// Update access order for LRU
		this.updateAccessOrder(key);

		// Return data with stale indicator
		return {
			data: entry.data,
			isStale: now > entry.staleAt
		};
	}

	/**
	 * Set item in cache with optional TTL
	 */
	set<T>(key: string, data: T, ttl?: number): void {
		const effectiveTTL = ttl ?? this.config.defaultTTL;
		const now = Date.now();

		// Evict if at capacity
		if (this.cache.size >= this.config.maxEntries && !this.cache.has(key)) {
			this.evictOldest();
		}

		this.cache.set(key, {
			data,
			expires: now + effectiveTTL,
			staleAt: now + effectiveTTL - this.config.staleWindow
		});

		this.updateAccessOrder(key);
	}

	/**
	 * Delete item from cache
	 */
	delete(key: string): boolean {
		this.removeFromAccessOrder(key);
		return this.cache.delete(key);
	}

	/**
	 * Clear all cached items
	 */
	clear(): void {
		this.cache.clear();
		this.accessOrder = [];
	}

	/**
	 * Get cache statistics
	 */
	stats(): { size: number; maxEntries: number } {
		return {
			size: this.cache.size,
			maxEntries: this.config.maxEntries
		};
	}

	private updateAccessOrder(key: string): void {
		this.removeFromAccessOrder(key);
		this.accessOrder.push(key);
	}

	private removeFromAccessOrder(key: string): void {
		const index = this.accessOrder.indexOf(key);
		if (index > -1) {
			this.accessOrder.splice(index, 1);
		}
	}

	private evictOldest(): void {
		if (this.accessOrder.length > 0) {
			const oldestKey = this.accessOrder.shift()!;
			this.cache.delete(oldestKey);
		}
	}
}

// Singleton instance for server-side caching
export const serverCache = new ServerCache();

/**
 * Helper to check if a request should skip cache (authenticated requests)
 */
export function shouldSkipCache(hasAuth: boolean): boolean {
	// Skip cache for authenticated requests as they may have user-specific data
	return hasAuth;
}
