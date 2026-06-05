/**
 * Unit tests for CORS origin handling, covering exact-match origins and the
 * trusted-suffix allowlist used for Cloudflare Pages preview deployments
 * (e.g. https://<hash>.numerai-model-reviewer.pages.dev).
 */
import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, resolveCorsOrigin, type CorsEnv } from './cors';

const env: CorsEnv = {
  ALLOWED_ORIGINS: 'http://localhost:5173,https://numerdiff.imperialai.ai',
  ALLOWED_ORIGIN_SUFFIXES: '.numerai-model-reviewer.pages.dev'
};

describe('isAllowedOrigin', () => {
  it('accepts an exact allowlisted origin', () => {
    expect(isAllowedOrigin('https://numerdiff.imperialai.ai', env)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', env)).toBe(true);
  });

  it('accepts a per-deployment Pages preview subdomain via suffix', () => {
    expect(isAllowedOrigin('https://7b4a080a.numerai-model-reviewer.pages.dev', env)).toBe(true);
  });

  it('accepts a branch-alias Pages preview subdomain via suffix', () => {
    expect(
      isAllowedOrigin('https://fix-crypto-stake-and-multipl.numerai-model-reviewer.pages.dev', env)
    ).toBe(true);
  });

  it('rejects a look-alike host that lacks the dot boundary', () => {
    // "evil-numerai-model-reviewer.pages.dev" must NOT match ".numerai-model-reviewer.pages.dev".
    expect(isAllowedOrigin('https://evil-numerai-model-reviewer.pages.dev', env)).toBe(false);
  });

  it('rejects a suffix match smuggled into a different parent domain', () => {
    expect(isAllowedOrigin('https://numerai-model-reviewer.pages.dev.evil.com', env)).toBe(false);
  });

  it('rejects an http (non-https) suffix match', () => {
    expect(isAllowedOrigin('http://7b4a080a.numerai-model-reviewer.pages.dev', env)).toBe(false);
  });

  it('rejects unknown origins and null', () => {
    expect(isAllowedOrigin('https://evil.com', env)).toBe(false);
    expect(isAllowedOrigin(null, env)).toBe(false);
  });

  it('matches only exact origins when no suffixes are configured', () => {
    const noSuffix: CorsEnv = { ALLOWED_ORIGINS: 'https://numerdiff.imperialai.ai' };
    expect(isAllowedOrigin('https://numerdiff.imperialai.ai', noSuffix)).toBe(true);
    expect(isAllowedOrigin('https://7b4a080a.numerai-model-reviewer.pages.dev', noSuffix)).toBe(false);
  });
});

describe('resolveCorsOrigin', () => {
  it('echoes an allowed origin', () => {
    expect(resolveCorsOrigin('https://7b4a080a.numerai-model-reviewer.pages.dev', env)).toBe(
      'https://7b4a080a.numerai-model-reviewer.pages.dev'
    );
  });

  it('falls back to the first exact origin for a disallowed origin', () => {
    expect(resolveCorsOrigin('https://evil.com', env)).toBe('http://localhost:5173');
  });
});
