import { describe, expect, it } from 'vitest';
import {
	SCORE_ALPHA_WEIGHT,
	SCORE_MPC_WEIGHT,
	SIGNALS_METRIC_SETS,
	DEFAULT_SIGNALS_METRIC_SET,
	NEUTRAL_SCORES_FROM_ROUND,
	computeScore,
	computeChartScore,
	formatMetricSetFormula,
	getMetricSetDefinition,
	hasNoNeutralData,
	shouldShowNeutralStartHint
} from './scoring.js';

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

describe('SIGNALS_METRIC_SETS', () => {
	it("defaults to the 'alpha_mpc' metric set", () => {
		expect(DEFAULT_SIGNALS_METRIC_SET).toBe('alpha_mpc');
	});

	it("'alpha_mpc' matches today's payout weights and labels", () => {
		expect(SIGNALS_METRIC_SETS.alpha_mpc).toEqual({
			key: 'alpha_mpc',
			corrWeight: 0.3,
			mmcWeight: 0.8,
			corrLabel: 'Alpha',
			mmcLabel: 'MPC'
		});
	});

	it("'neutral' matches the pair Numerai pays on for rounds opening on/after 2026-09-25", () => {
		expect(SIGNALS_METRIC_SETS.neutral).toEqual({
			key: 'neutral',
			corrWeight: 0.5,
			mmcWeight: 2,
			corrLabel: 'NCORR',
			mmcLabel: 'NMMC'
		});
	});

	it('getMetricSetDefinition looks up a set by key', () => {
		expect(getMetricSetDefinition('neutral')).toBe(SIGNALS_METRIC_SETS.neutral);
	});
});

describe('formatMetricSetFormula', () => {
	it('renders the alpha_mpc formula text', () => {
		expect(formatMetricSetFormula('alpha_mpc')).toBe('0.3·Alpha + 0.8·MPC');
	});

	it('renders the neutral formula text', () => {
		expect(formatMetricSetFormula('neutral')).toBe('0.5·NCORR + 2·NMMC');
	});
});

describe('shouldShowNeutralStartHint', () => {
	it('Numerai\'s first Signals round with neutral scores is 912', () => {
		expect(NEUTRAL_SCORES_FROM_ROUND).toBe(912);
	});

	it('is false for alpha_mpc regardless of round range', () => {
		expect(shouldShowNeutralStartHint('alpha_mpc', 1)).toBe(false);
		expect(shouldShowNeutralStartHint('alpha_mpc', 912)).toBe(false);
	});

	it('is true for neutral when the range starts at or before round 912', () => {
		expect(shouldShowNeutralStartHint('neutral', 1)).toBe(true);
		expect(shouldShowNeutralStartHint('neutral', 911)).toBe(true);
		expect(shouldShowNeutralStartHint('neutral', 912)).toBe(true);
	});

	it('is false for neutral once the range starts after round 912', () => {
		expect(shouldShowNeutralStartHint('neutral', 913)).toBe(false);
		expect(shouldShowNeutralStartHint('neutral', 1200)).toBe(false);
	});
});

describe('hasNoNeutralData', () => {
	it('is false for an empty range (the "no data at all" fallback handles that case)', () => {
		expect(hasNoNeutralData([])).toBe(false);
	});

	it('is true when every point has null ncorr and nmmc', () => {
		expect(hasNoNeutralData([
			{ ncorr: null, nmmc: null },
			{ ncorr: null, nmmc: null }
		])).toBe(true);
	});

	it('is false when at least one point has a neutral value', () => {
		expect(hasNoNeutralData([
			{ ncorr: null, nmmc: null },
			{ ncorr: 0.02, nmmc: null }
		])).toBe(false);
		expect(hasNoNeutralData([
			{ ncorr: null, nmmc: 0.01 }
		])).toBe(false);
	});
});

describe('computeChartScore', () => {
	const values = { alpha: 0.02, mpc: 0.03, ncorr: 0.05, nmmc: 0.01 };

	it("scores alpha/mpc for 'classic' (the chart's long-standing default score)", () => {
		expect(computeChartScore('classic', values, 0.3, 0.8)).toBeCloseTo(0.3 * 0.02 + 0.8 * 0.03, 12);
	});

	it("scores alpha/mpc for 'alpha_mpc'", () => {
		expect(computeChartScore('alpha_mpc', values, 0.3, 0.8)).toBeCloseTo(0.3 * 0.02 + 0.8 * 0.03, 12);
	});

	it("scores ncorr/nmmc for 'neutral'", () => {
		expect(computeChartScore('neutral', values, 0.5, 2)).toBeCloseTo(0.5 * 0.05 + 2 * 0.01, 12);
	});

	it('returns null when both relevant components are absent', () => {
		expect(computeChartScore('neutral', { alpha: 1, mpc: 1, ncorr: null, nmmc: null }, 0.5, 2)).toBeNull();
		expect(computeChartScore('alpha_mpc', { alpha: null, mpc: null, ncorr: 1, nmmc: 1 }, 0.3, 0.8)).toBeNull();
	});
});
