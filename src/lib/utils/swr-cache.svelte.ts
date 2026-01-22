/**
 * SWR (Stale-While-Revalidate) cache utility for Svelte 5
 * Provides reactive caching with automatic revalidation
 */

interface CacheEntry<T> {
	data: T;
	error: Error | null;
	timestamp: number;
	isValidating: boolean;
}

interface SWROptions {
	/** Time in ms before data is considered stale (default: 5 minutes) */
	staleTime?: number;
	/** Time in ms before cached data expires completely (default: 30 minutes) */
	cacheTime?: number;
	/** Revalidate when window regains focus */
	revalidateOnFocus?: boolean;
	/** Revalidate when network reconnects */
	revalidateOnReconnect?: boolean;
	/** Dedupe interval in ms - skip fetches within this window */
	dedupingInterval?: number;
}

interface SWRState<T> {
	data: T | undefined;
	error: Error | null;
	isLoading: boolean;
	isValidating: boolean;
	isStale: boolean;
}

const DEFAULT_OPTIONS: Required<SWROptions> = {
	staleTime: 5 * 60 * 1000, // 5 minutes
	cacheTime: 30 * 60 * 1000, // 30 minutes
	revalidateOnFocus: true,
	revalidateOnReconnect: true,
	dedupingInterval: 2000 // 2 seconds
};

/**
 * Global cache store for SWR data
 */
class SWRCache {
	private cache: Map<string, CacheEntry<unknown>> = new Map();
	private subscribers: Map<string, Set<() => void>> = new Map();
	private inflightRequests: Map<string, Promise<unknown>> = new Map();
	private lastFetchTime: Map<string, number> = new Map();
	private options: Required<SWROptions>;
	private focusListener: (() => void) | null = null;
	private onlineListener: (() => void) | null = null;

	constructor(options: SWROptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
		this.setupEventListeners();
	}

	private setupEventListeners(): void {
		if (typeof window === 'undefined') return;

		// Revalidate on focus
		if (this.options.revalidateOnFocus) {
			this.focusListener = () => {
				this.revalidateAll();
			};
			window.addEventListener('focus', this.focusListener);
		}

		// Revalidate on reconnect
		if (this.options.revalidateOnReconnect) {
			this.onlineListener = () => {
				this.revalidateAll();
			};
			window.addEventListener('online', this.onlineListener);
		}
	}

	/**
	 * Get cached data with SWR semantics
	 */
	get<T>(key: string): SWRState<T> {
		const entry = this.cache.get(key) as CacheEntry<T> | undefined;
		const now = Date.now();

		if (!entry) {
			return {
				data: undefined,
				error: null,
				isLoading: false,
				isValidating: false,
				isStale: true
			};
		}

		// Check if data has expired completely
		if (now - entry.timestamp > this.options.cacheTime) {
			this.cache.delete(key);
			return {
				data: undefined,
				error: null,
				isLoading: false,
				isValidating: false,
				isStale: true
			};
		}

		const isStale = now - entry.timestamp > this.options.staleTime;

		return {
			data: entry.data,
			error: entry.error,
			isLoading: false,
			isValidating: entry.isValidating,
			isStale
		};
	}

	/**
	 * Set cached data
	 */
	set<T>(key: string, data: T, error: Error | null = null): void {
		const existing = this.cache.get(key);
		this.cache.set(key, {
			data,
			error,
			timestamp: Date.now(),
			isValidating: existing?.isValidating ?? false
		});
		this.notifySubscribers(key);
	}

	/**
	 * Set validating state
	 */
	setValidating(key: string, isValidating: boolean): void {
		const entry = this.cache.get(key);
		if (entry) {
			entry.isValidating = isValidating;
			this.notifySubscribers(key);
		}
	}

	/**
	 * Fetch data with deduplication and caching
	 */
	async fetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
		const now = Date.now();
		const lastFetch = this.lastFetchTime.get(key) ?? 0;

		// Check deduping interval
		if (now - lastFetch < this.options.dedupingInterval) {
			const inflight = this.inflightRequests.get(key);
			if (inflight) {
				return inflight as Promise<T>;
			}
		}

		// Check if we have fresh cached data
		const cached = this.get<T>(key);
		if (cached.data && !cached.isStale) {
			return cached.data;
		}

		// Reuse inflight request if exists
		const existing = this.inflightRequests.get(key);
		if (existing) {
			return existing as Promise<T>;
		}

		// Mark as validating
		this.setValidating(key, true);
		this.lastFetchTime.set(key, now);

		// Create new request
		const request = fetcher()
			.then((data) => {
				this.set(key, data, null);
				return data;
			})
			.catch((error) => {
				// Keep stale data on error, but store the error
				const current = this.cache.get(key);
				if (current) {
					current.error = error;
					current.isValidating = false;
				} else {
					this.set(key, undefined as T, error);
				}
				this.notifySubscribers(key);
				throw error;
			})
			.finally(() => {
				this.inflightRequests.delete(key);
				this.setValidating(key, false);
			});

		this.inflightRequests.set(key, request);
		return request;
	}

	/**
	 * Subscribe to cache updates for a key
	 */
	subscribe(key: string, callback: () => void): () => void {
		if (!this.subscribers.has(key)) {
			this.subscribers.set(key, new Set());
		}
		this.subscribers.get(key)!.add(callback);

		// Return unsubscribe function
		return () => {
			const subs = this.subscribers.get(key);
			if (subs) {
				subs.delete(callback);
				if (subs.size === 0) {
					this.subscribers.delete(key);
				}
			}
		};
	}

	private notifySubscribers(key: string): void {
		const subs = this.subscribers.get(key);
		if (subs) {
			subs.forEach((callback) => callback());
		}
	}

	/**
	 * Invalidate a specific cache key
	 */
	invalidate(key: string): void {
		this.cache.delete(key);
		this.notifySubscribers(key);
	}

	/**
	 * Invalidate all cache keys matching a pattern
	 */
	invalidatePattern(pattern: RegExp): void {
		for (const key of this.cache.keys()) {
			if (pattern.test(key)) {
				this.cache.delete(key);
				this.notifySubscribers(key);
			}
		}
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		const keys = Array.from(this.cache.keys());
		this.cache.clear();
		keys.forEach((key) => this.notifySubscribers(key));
	}

	/**
	 * Revalidate all stale entries
	 */
	private revalidateAll(): void {
		// This triggers subscribers which should trigger refetch
		for (const key of this.cache.keys()) {
			const state = this.get(key);
			if (state.isStale) {
				this.notifySubscribers(key);
			}
		}
	}

	/**
	 * Cleanup event listeners
	 */
	destroy(): void {
		if (typeof window === 'undefined') return;

		if (this.focusListener) {
			window.removeEventListener('focus', this.focusListener);
		}
		if (this.onlineListener) {
			window.removeEventListener('online', this.onlineListener);
		}
	}

	/**
	 * Get cache statistics
	 */
	stats(): { size: number; keys: string[] } {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys())
		};
	}
}

// Singleton instance
export const swrCache = new SWRCache();

/**
 * Cache key generators for common Numerai API queries
 */
export const cacheKeys = {
	userSearch: (query: string) => `user-search:${query.toLowerCase()}`,
	userModels: (username: string) => `user-models:${username.toLowerCase()}`,
	modelPerformance: (modelName: string) => `model-performance:${modelName.toLowerCase()}`,
	accountProfile: (username: string) => `account-profile:${username.toLowerCase()}`
} as const;

/**
 * Custom stale times for different query types (client-side)
 */
export const CLIENT_STALE_TIMES = {
	userSearch: 10 * 60 * 1000, // 10 minutes
	userModels: 10 * 60 * 1000, // 10 minutes
	modelPerformance: 3 * 60 * 1000, // 3 minutes (fresher on client)
	accountProfile: 10 * 60 * 1000 // 10 minutes
} as const;
