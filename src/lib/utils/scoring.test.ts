import { describe, expect, it } from 'vitest';
import { SCORE_ALPHA_WEIGHT, SCORE_MPC_WEIGHT, computeScore } from './scoring.js';

describe('scoring', () => {
	it('uses the default Numerai Signals weights (0.3 * alpha + 0.8 * mpc)', () => {
		expect(SCORE_ALPHA_WEIGHT).toBe(0.3);
		expect(SCORE_MPC_WEIGHT).toBe(0.8);
	});

	it('computes the weighted score from alpha and mpc', () => {
		expect(computeScore(0.02, 0.03)).toBeCloseTo(0.3 * 0.02 + 0.8 * 0.03, 12);
	});

	it('treats a missing component as zero when the other is present', () => {
		expect(computeScore(0.02, null)).toBeCloseTo(0.3 * 0.02, 12);
		expect(computeScore(null, 0.03)).toBeCloseTo(0.8 * 0.03, 12);
	});

	it('returns null when both components are absent', () => {
		expect(computeScore(null, null)).toBeNull();
		expect(computeScore(undefined, undefined)).toBeNull();
	});

	it('accepts custom weights', () => {
		expect(computeScore(0.1, 0.2, 1, 1)).toBeCloseTo(0.3, 12);
	});
});
