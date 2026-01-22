/**
 * Server-side proxy for Numerai GraphQL API to avoid CORS issues
 * Includes in-memory caching with TTL support
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { serverCache, ServerCache, CACHE_TTLS, shouldSkipCache } from '$lib/server/cache.js';

const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

// In-memory rate limiting (per server instance)
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimit = new Map<string, { count: number; resetAt: number }>();
let lastRateLimitCleanup = 0;

function cleanupRateLimit(now: number): void {
	if (now - lastRateLimitCleanup < 24 * 60 * 60 * 1000) {
		return;
	}
	lastRateLimitCleanup = now;
	for (const [key, entry] of rateLimit.entries()) {
		if (entry.resetAt <= now) {
			rateLimit.delete(key);
		}
	}
}

function getClientKey(request: Request): string {
	const cfConnectingIp = request.headers.get('cf-connecting-ip');
	if (cfConnectingIp) return cfConnectingIp;
	const forwardedFor = request.headers.get('x-forwarded-for');
	if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || 'unknown';
	return 'unknown';
}

function checkRateLimit(request: Request): { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number } {
	const now = Date.now();
	cleanupRateLimit(now);

	const key = getClientKey(request);
	const entry = rateLimit.get(key);

	if (!entry || now > entry.resetAt) {
		const resetAt = now + RATE_LIMIT_WINDOW_MS;
		rateLimit.set(key, { count: 1, resetAt });
		return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt };
	}

	if (entry.count >= RATE_LIMIT_MAX) {
		return {
			allowed: false,
			remaining: 0,
			resetAt: entry.resetAt,
			retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
		};
	}

	entry.count += 1;
	return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetAt: entry.resetAt };
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const rateLimitResult = checkRateLimit(request);
		if (!rateLimitResult.allowed) {
			return json(
				{ errors: [{ message: 'Rate limit exceeded' }], retryAfter: rateLimitResult.retryAfter },
				{
					status: 429,
					headers: {
						'Retry-After': String(rateLimitResult.retryAfter ?? 1),
						'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
						'X-RateLimit-Remaining': '0',
						'X-RateLimit-Reset': String(rateLimitResult.resetAt)
					}
				}
			);
		}

		const body = await request.json();
		const { query, variables, publicId, secretKey } = body;

		if (!query) {
			return json({ errors: [{ message: 'Query is required' }] }, { status: 400 });
		}

		const hasAuth = !!(publicId && secretKey);

		// Generate cache key and check cache (skip for authenticated requests)
		const cacheKey = ServerCache.generateKey(query, variables);

		if (!shouldSkipCache(hasAuth)) {
			const cached = serverCache.get<unknown>(cacheKey);
			if (cached && !cached.isStale) {
				// Fresh cache hit - return immediately
				return json(cached.data, {
					headers: {
						'X-Cache': 'HIT',
						'X-Cache-TTL': 'fresh',
						'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
						'X-RateLimit-Remaining': String(rateLimitResult.remaining),
						'X-RateLimit-Reset': String(rateLimitResult.resetAt)
					}
				});
			}

			// Stale cache hit - return stale data but we could trigger background revalidation
			// For simplicity, just serve stale and let next request refresh
			if (cached && cached.isStale) {
				return json(cached.data, {
					headers: {
						'X-Cache': 'HIT',
						'X-Cache-TTL': 'stale',
						'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
						'X-RateLimit-Remaining': String(rateLimitResult.remaining),
						'X-RateLimit-Reset': String(rateLimitResult.resetAt)
					}
				});
			}
		}

		// Cache miss or authenticated request - fetch from API
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		if (hasAuth) {
			headers['Authorization'] = `Token ${publicId}$${secretKey}`;
		}

		const response = await fetch(NUMERAI_API_URL, {
			method: 'POST',
			headers,
			body: JSON.stringify({ query, variables })
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('Numerai API error:', response.status, errorText);
			return json(
				{ errors: [{ message: `API request failed: ${response.status} ${response.statusText}` }] },
				{ status: response.status }
			);
		}

		const result = await response.json();

		// Cache successful responses (non-authenticated only)
		if (!shouldSkipCache(hasAuth) && !result.errors) {
			const queryType = ServerCache.detectQueryType(query);
			const ttl = CACHE_TTLS[queryType];
			serverCache.set(cacheKey, result, ttl);
		}

		return json(result, {
			headers: {
				'X-Cache': 'MISS',
				'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
				'X-RateLimit-Remaining': String(rateLimitResult.remaining),
				'X-RateLimit-Reset': String(rateLimitResult.resetAt)
			}
		});
	} catch (error) {
		console.error('Proxy error:', error);
		return json(
			{ errors: [{ message: error instanceof Error ? error.message : 'Unknown error' }] },
			{ status: 500 }
		);
	}
};

/**
 * GET endpoint to check cache stats (for debugging/monitoring)
 */
export const GET: RequestHandler = async ({ request }) => {
	const rateLimitResult = checkRateLimit(request);
	if (!rateLimitResult.allowed) {
		return json(
			{ errors: [{ message: 'Rate limit exceeded' }], retryAfter: rateLimitResult.retryAfter },
			{
				status: 429,
				headers: {
					'Retry-After': String(rateLimitResult.retryAfter ?? 1),
					'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
					'X-RateLimit-Remaining': '0',
					'X-RateLimit-Reset': String(rateLimitResult.resetAt)
				}
			}
		);
	}

	const stats = serverCache.stats();
	return json({
		cache: stats,
		ttls: CACHE_TTLS
	}, {
		headers: {
			'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
			'X-RateLimit-Remaining': String(rateLimitResult.remaining),
			'X-RateLimit-Reset': String(rateLimitResult.resetAt)
		}
	});
};
