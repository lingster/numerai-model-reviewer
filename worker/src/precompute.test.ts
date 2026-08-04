/**
 * Unit tests for pure helpers in precompute.ts.
 *
 * Importing precompute.ts is safe (main() is guarded behind a CLI entry-point
 * check), so only the pure functions run here — no API calls.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCryptoMetrics,
  computeMinRound,
  computeRoundsToFetch,
  parseRetryAfterMs,
  computeBackoffMs,
  RETRY_BASE_MS,
  RETRY_CAP_MS
} from './precompute';

describe('extractCryptoMetrics', () => {
  it('pulls corr and mmc out of crypto submissionScores', () => {
    const scores = [
      { displayName: 'canon_corr', value: 0.99 },
      { displayName: 'corr', value: 0.0612 },
      { displayName: 'mmc', value: -0.0028 },
      { displayName: 'season_score', value: 0.5 }
    ];
    expect(extractCryptoMetrics(scores)).toEqual({ corr: 0.0612, mmc: -0.0028 });
  });

  it('returns nulls when corr/mmc are absent', () => {
    expect(extractCryptoMetrics([{ displayName: 'season_score', value: 0.5 }])).toEqual({
      corr: null,
      mmc: null
    });
  });

  it('preserves explicit null score values (unresolved round)', () => {
    const scores = [
      { displayName: 'corr', value: null },
      { displayName: 'mmc', value: null }
    ];
    expect(extractCryptoMetrics(scores)).toEqual({ corr: null, mmc: null });
  });

  it('handles a null submissionScores array', () => {
    expect(extractCryptoMetrics(null)).toEqual({ corr: null, mmc: null });
  });
});

describe('computeMinRound (incremental refresh floor)', () => {
  it('returns 0 (full backfill) when D1 is empty for the tournament', () => {
    expect(computeMinRound(null, false, 2)).toBe(0);
  });

  it('returns 0 (full backfill) on --reset regardless of existing rounds', () => {
    expect(computeMinRound(1275, true, 2)).toBe(0);
  });

  it('starts overlap rounds before the last stored round', () => {
    // D1 has up to 1275, overlap 2 -> re-fetch from 1274 (1274, 1275, then new).
    expect(computeMinRound(1275, false, 2)).toBe(1274);
  });

  it('writes only strictly-new rounds when overlap is 0 (minimum writes)', () => {
    // D1 has up to 1290, overlap 0 -> next run starts at 1291 (nothing re-written).
    expect(computeMinRound(1290, false, 0)).toBe(1291);
  });

  it('never returns a negative round when history is shorter than the overlap', () => {
    expect(computeMinRound(1, false, 2)).toBe(0);
    expect(computeMinRound(0, false, 2)).toBe(0);
  });

  it('supports a larger overlap window', () => {
    expect(computeMinRound(1290, false, 10)).toBe(1281);
  });
});

describe('computeRoundsToFetch (lastNRounds bound)', () => {
  it('fetches the full cap when doing a backfill (minRound 0)', () => {
    expect(computeRoundsToFetch(0, 1290, 1000)).toBe(1000);
  });

  it('fetches only the incremental window plus overlap', () => {
    // from 1274 through current 1290 inclusive = 17 rounds.
    expect(computeRoundsToFetch(1274, 1290, 1000)).toBe(17);
  });

  it('caps the window at the history ceiling', () => {
    expect(computeRoundsToFetch(1, 5000, 1000)).toBe(1000);
  });

  it('always fetches at least one round', () => {
    // Defensive: minRound ahead of current round should not yield 0/negative.
    expect(computeRoundsToFetch(1300, 1290, 1000)).toBe(1);
  });
});

describe('parseRetryAfterMs (429 Retry-After)', () => {
  const NOW = 1_000_000_000_000; // fixed clock

  it('returns null for missing/empty values', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterMs('', NOW)).toBeNull();
  });

  it('parses delta-seconds into milliseconds', () => {
    expect(parseRetryAfterMs('5', NOW)).toBe(5000);
    expect(parseRetryAfterMs('0', NOW)).toBe(0);
    expect(parseRetryAfterMs('120', NOW)).toBe(120000);
  });

  it('parses an HTTP-date relative to now', () => {
    const when = new Date(NOW + 8000).toUTCString(); // whole-second precision
    expect(parseRetryAfterMs(when, NOW)).toBe(8000);
  });

  it('clamps a past HTTP-date to 0', () => {
    const past = new Date(NOW - 60000).toUTCString();
    expect(parseRetryAfterMs(past, NOW)).toBe(0);
  });

  it('returns null for unparseable values', () => {
    expect(parseRetryAfterMs('soon', NOW)).toBeNull();
  });
});

describe('computeBackoffMs (exponential from 30s, respects Retry-After)', () => {
  it('uses 30s as the initial backoff when no Retry-After is given', () => {
    expect(computeBackoffMs(0, null)).toBe(RETRY_BASE_MS);
    expect(RETRY_BASE_MS).toBe(30_000);
  });

  it('doubles per attempt', () => {
    expect(computeBackoffMs(1, null)).toBe(60_000);
    expect(computeBackoffMs(2, null)).toBe(120_000);
    expect(computeBackoffMs(3, null)).toBe(240_000);
  });

  it('caps the exponential growth', () => {
    expect(computeBackoffMs(4, null)).toBe(RETRY_CAP_MS); // 30s*16=480s -> capped
    expect(computeBackoffMs(10, null)).toBe(RETRY_CAP_MS);
  });

  it('respects a server Retry-After over the exponential schedule', () => {
    expect(computeBackoffMs(0, 5000)).toBe(5000);
    expect(computeBackoffMs(3, 2000)).toBe(2000);
  });

  it('caps an oversized Retry-After', () => {
    expect(computeBackoffMs(0, 999_999_999)).toBe(RETRY_CAP_MS);
  });
});
