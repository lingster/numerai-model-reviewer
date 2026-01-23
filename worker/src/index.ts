/**
 * Numerai API Proxy - Cloudflare Worker
 *
 * Proxies GraphQL requests to the Numerai Tournament API with:
 * - CORS handling
 * - Rate limiting
 * - Authentication header injection
 */

// Environment bindings interface
interface Env {
  // Secrets (set via wrangler secret put)
  NUMERAI_PUBLIC_KEY: string;
  NUMERAI_SECRET_KEY: string;

  // Environment variables
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_REQUESTS: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  NUMERAI_API_URL: string;

  // KV namespace for rate limiting (optional)
  RATE_LIMIT?: KVNamespace;
}

// Rate limit entry stored in KV
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// GraphQL request body
interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

// Numerai GraphQL response
interface NumeraiResponse {
  data?: unknown;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

/**
 * Parse allowed origins from environment variable
 */
function getAllowedOrigins(env: Env): Set<string> {
  const origins = env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || [];
  return new Set(origins);
}

function isAllowedOrigin(origin: string | null, env: Env): boolean {
  const allowedOrigins = getAllowedOrigins(env);
  return Boolean(origin && allowedOrigins.has(origin));
}

// In-memory fallback rate limiting (per worker isolate)
const inMemoryRateLimit = new Map<string, RateLimitEntry>();
let lastRateLimitCleanup = 0;
const MAX_IN_MEMORY_RATE_LIMIT_ENTRIES = 10000;

function cleanupInMemoryRateLimit(nowSeconds: number): void {
  if (nowSeconds - lastRateLimitCleanup < 24 * 60 * 60) {
    return;
  }
  lastRateLimitCleanup = nowSeconds;
  for (const [key, entry] of inMemoryRateLimit.entries()) {
    if (entry.resetAt <= nowSeconds) {
      inMemoryRateLimit.delete(key);
    }
  }
}

function ensureInMemoryLimitCapacity(nowSeconds: number): void {
  if (inMemoryRateLimit.size < MAX_IN_MEMORY_RATE_LIMIT_ENTRIES) {
    return;
  }

  // Drop expired entries first.
  for (const [key, entry] of inMemoryRateLimit.entries()) {
    if (entry.resetAt <= nowSeconds) {
      inMemoryRateLimit.delete(key);
    }
  }

  // If still over capacity, evict arbitrary oldest entries.
  while (inMemoryRateLimit.size >= MAX_IN_MEMORY_RATE_LIMIT_ENTRIES) {
    const oldestKey = inMemoryRateLimit.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    inMemoryRateLimit.delete(oldestKey);
  }
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const allowedOrigins = getAllowedOrigins(env);
      if (!isAllowedOrigin(origin, env)) {
        return new Response(JSON.stringify({
          error: 'Forbidden origin',
          debug: {
            receivedOrigin: origin,
            allowedOrigins: Array.from(allowedOrigins),
            envValue: env.ALLOWED_ORIGINS
          }
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return handleCors(origin, env, new Response(null, { status: 204 }));
    }

    try {
      // Route requests
      if (path === '/health' && request.method === 'GET') {
        return handleCors(origin, env, handleHealth());
      }

      if (path === '/graphql' && request.method === 'POST') {
        if (!isAllowedOrigin(origin, env)) {
          return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return handleCors(origin, env, await handleGraphQL(request, env, ctx));
      }

      // 404 for unknown routes
      return handleCors(
        origin,
        env,
        new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    } catch (error) {
      console.error('Unhandled error:', error);
      return handleCors(
        origin,
        env,
        new Response(
          JSON.stringify({
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error'
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      );
    }
  }
};

/**
 * Handle CORS headers
 */
function handleCors(origin: string | null, env: Env, response: Response): Response {
  const allowedOrigins = getAllowedOrigins(env);
  const corsOrigin = (origin && allowedOrigins.has(origin)) ? origin : allowedOrigins.values().next().value;

  // Clone response with CORS headers
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', corsOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Health check endpoint
 */
function handleHealth(): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'numerai-api-proxy'
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * Handle GraphQL proxy requests
 */
async function handleGraphQL(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Get client IP for rate limiting
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Check rate limit
  const rateLimitResult = await checkRateLimit(clientIP, env, ctx);
  if (!rateLimitResult.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.retryAfter
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitResult.retryAfter),
          'X-RateLimit-Limit': env.RATE_LIMIT_REQUESTS,
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateLimitResult.resetAt)
        }
      }
    );
  }

  // Parse request body
  let body: GraphQLRequest;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Validate query
  if (!body.query || typeof body.query !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing or invalid query field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Proxy to Numerai API
  const numeraiResponse = await fetch(env.NUMERAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${env.NUMERAI_PUBLIC_KEY}$${env.NUMERAI_SECRET_KEY}`
    },
    body: JSON.stringify(body)
  });

  // Get response data
  const responseData: NumeraiResponse = await numeraiResponse.json();

  // Return response with rate limit headers
  return new Response(JSON.stringify(responseData), {
    status: numeraiResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit': env.RATE_LIMIT_REQUESTS,
      'X-RateLimit-Remaining': String(rateLimitResult.remaining),
      'X-RateLimit-Reset': String(rateLimitResult.resetAt)
    }
  });
}

/**
 * Rate limiting using KV or in-memory fallback
 */
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

async function checkRateLimit(
  clientIP: string,
  env: Env,
  ctx: ExecutionContext
): Promise<RateLimitResult> {
  const limit = parseInt(env.RATE_LIMIT_REQUESTS, 10) || 100;
  const windowSeconds = parseInt(env.RATE_LIMIT_WINDOW_SECONDS, 10) || 60;
  const now = Math.floor(Date.now() / 1000);
  cleanupInMemoryRateLimit(now);
  const windowStart = now - (now % windowSeconds);
  const resetAt = windowStart + windowSeconds;

  const key = `rate:${clientIP}:${windowStart}`;

  // If KV is configured, use it for distributed rate limiting
  if (env.RATE_LIMIT) {
    try {
      const stored = await env.RATE_LIMIT.get<RateLimitEntry>(key, 'json');
      const current = stored?.count || 0;

      if (current >= limit) {
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfter: resetAt - now
        };
      }

      // Increment counter
      const newEntry: RateLimitEntry = {
        count: current + 1,
        resetAt
      };

      // Store with TTL equal to window
      ctx.waitUntil(
        env.RATE_LIMIT.put(key, JSON.stringify(newEntry), {
          expirationTtl: windowSeconds
        })
      );

      return {
        allowed: true,
        remaining: limit - current - 1,
        resetAt
      };
    } catch (error) {
      console.error('KV rate limit error:', error);
      // Fall through to in-memory rate limiting on KV error
    }
  }

  // In-memory fallback rate limiting (best-effort)
  const existing = inMemoryRateLimit.get(key);
  const current = existing?.count ?? 0;
  const existingReset = existing?.resetAt ?? resetAt;

  if (existing && existingReset !== resetAt) {
    inMemoryRateLimit.delete(key);
  }

  if (current >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: resetAt - now
    };
  }

  ensureInMemoryLimitCapacity(now);
  inMemoryRateLimit.set(key, { count: current + 1, resetAt });

  return {
    allowed: true,
    remaining: limit - 1,
    resetAt
  };
}
