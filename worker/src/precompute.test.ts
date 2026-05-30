/**
 * Unit tests for pure helpers in precompute.ts.
 *
 * Importing precompute.ts is safe (main() is guarded behind a CLI entry-point
 * check), so only the pure functions run here — no API calls.
 */
import { describe, it, expect } from 'vitest';
import { extractCryptoMetrics } from './precompute';

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
