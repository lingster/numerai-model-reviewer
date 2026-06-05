/**
 * CORS origin handling.
 *
 * Origins are accepted if they either match the exact `ALLOWED_ORIGINS`
 * allowlist or end with one of the trusted `ALLOWED_ORIGIN_SUFFIXES`. The
 * suffix list lets Cloudflare Pages preview deployments — whose subdomains are
 * generated per-deploy (e.g. `https://<hash>.numerai-model-reviewer.pages.dev`)
 * — talk to the API without listing every ephemeral URL.
 */

/** Just the env vars CORS needs (a subset of the worker Env). */
export interface CorsEnv {
  ALLOWED_ORIGINS: string;
  ALLOWED_ORIGIN_SUFFIXES?: string;
}

function parseCsv(value: string | undefined): string[] {
  return value?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
}

/** Exact-match origin allowlist. */
export function getAllowedOrigins(env: CorsEnv): Set<string> {
  return new Set(parseCsv(env.ALLOWED_ORIGINS));
}

/** Trusted host suffixes (e.g. `.numerai-model-reviewer.pages.dev`). */
export function getAllowedOriginSuffixes(env: CorsEnv): string[] {
  return parseCsv(env.ALLOWED_ORIGIN_SUFFIXES);
}

/**
 * True when `origin` is exactly allowlisted, or is an https origin whose
 * hostname ends with a trusted suffix. The leading-dot suffix enforces a label
 * boundary, so `evil-numerai-model-reviewer.pages.dev` does NOT match
 * `.numerai-model-reviewer.pages.dev`.
 */
export function isAllowedOrigin(origin: string | null, env: CorsEnv): boolean {
  if (!origin) return false;
  if (getAllowedOrigins(env).has(origin)) return true;

  const suffixes = getAllowedOriginSuffixes(env);
  if (suffixes.length === 0) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Previews are always served over https; only echo such origins back.
  if (url.protocol !== 'https:') return false;

  return suffixes.some((suffix) => url.hostname.endsWith(suffix));
}

/**
 * The value to send in `Access-Control-Allow-Origin`: the request origin when
 * allowed, otherwise the first exact allowlisted origin (preserving prior
 * behaviour for disallowed callers).
 */
export function resolveCorsOrigin(origin: string | null, env: CorsEnv): string {
  if (isAllowedOrigin(origin, env)) return origin as string;
  return getAllowedOrigins(env).values().next().value ?? '';
}

/** Apply CORS headers to a response. */
export function handleCors(origin: string | null, env: CorsEnv, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', resolveCorsOrigin(origin, env));
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  // Vary on Origin so caches don't serve one origin's ACAO header to another.
  headers.append('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
