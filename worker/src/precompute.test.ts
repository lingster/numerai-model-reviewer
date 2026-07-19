/**
 * Unit tests for pure helpers in precompute.ts.
 *
 * Importing precompute.ts is safe (main() is guarded behind a CLI entry-point
 * check), so only the pure functions run here — no API calls.
 */
import { describe, it, expect } from 'vitest';
import { extractCryptoMetrics, computeMinRound, computeRoundsToFetch } from './precompute';

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
