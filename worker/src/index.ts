/**
 * Numerai API Proxy - Cloudflare Worker
 * Refactored to expose REST endpoints and handle GraphQL generation on the backend.
 */
import * as api from './api';
import { Env as ApiEnv } from './api';
import { CRYPTO_TOURNAMENT } from './mappers';

// Environment bindings interface
interface Env extends ApiEnv {
  // Rate limiting vars
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_REQUESTS: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT?: KVNamespace;
}

// Rate limit entry stored in KV
interface RateLimitEntry {
  count: number;
  resetAt: number;
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
  for (const [key, entry] of inMemoryRateLimit.entries()) {
    if (entry.resetAt <= nowSeconds) {
      inMemoryRateLimit.delete(key);
    }
  }
  while (inMemoryRateLimit.size >= MAX_IN_MEMORY_RATE_LIMIT_ENTRIES) {
    const oldestKey = inMemoryRateLimit.keys().next().value as string | undefined;
    if (!oldestKey) break;
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
        return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return handleCors(origin, env, new Response(null, { status: 204 }));
    }

    try {
      // Check rate limit for API calls
      if (path !== '/health') {
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
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
      }

      // Router
      if (!isAllowedOrigin(origin, env) && path !== '/health') {
        return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let response: Response;

      // GET /health
      if (path === '/health') {
        response = handleHealth();
      }
      // GET /search/users?q=...
      else if (path === '/search/users' && request.method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q) throw new Error('Missing q parameter');
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const results = await api.searchUsers(q, env, limit);
        response = jsonResponse(results);
      }
      // GET /users/:username/models
      else if (path.match(/^\/users\/[^/]+\/models$/) && request.method === 'GET') {
        const username = path.split('/')[2]; // /users/USERNAME/models
        const tournament = url.searchParams.get('tournament');
        const results = await api.getUserModels(username, env, tournament ? parseInt(tournament) : undefined);
        response = jsonResponse(results);
      }
      // GET /models/:modelName/performance
      else if (path.match(/^\/models\/[^/]+\/performance$/) && request.method === 'GET') {
        const modelName = path.split('/')[2];
        const username = url.searchParams.get('username') || undefined;
        const modelId = url.searchParams.get('modelId') || undefined;
        const tournament = url.searchParams.get('tournament');
        const result = await api.getModelPerformance(
          modelName, 
          env, 
          username, 
          modelId, 
          tournament ? parseInt(tournament) : undefined
        );
        response = result ? jsonResponse(result) : new Response(JSON.stringify({ error: 'Model not found' }), { status: 404 });
      }
      // GET /models/:modelName
      else if (path.match(/^\/models\/[^/]+$/) && request.method === 'GET') {
        const modelName = path.split('/')[2];
        const tournamentParam = url.searchParams.get('tournament');
        const tournament = tournamentParam ? parseInt(tournamentParam) : undefined;

        let result = null;
        if (tournament === CRYPTO_TOURNAMENT) {
             result = await api.findCryptoModelByName(modelName, CRYPTO_TOURNAMENT, env);
        } else {
             result = await api.getModelByName(modelName, env, tournament);
        }
        
        response = result ? jsonResponse(result) : new Response(JSON.stringify({ error: 'Model not found' }), { status: 404 });
      }
      else {
        response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      return handleCors(origin, env, response);
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

function jsonResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Handle CORS headers
 */
function handleCors(origin: string | null, env: Env, response: Response): Response {
  const allowedOrigins = getAllowedOrigins(env);
  const corsOrigin = (origin && allowedOrigins.has(origin))
    ? origin
    : (allowedOrigins.values().next().value ?? '');

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

      const newEntry: RateLimitEntry = {
        count: current + 1,
        resetAt
      };

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
    }
  }

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