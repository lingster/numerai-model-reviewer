import { describe, expect, it } from 'vitest';
import {
	CLASSIC_SIXTY_DAY_FORMULA,
	SCORE_ALPHA_WEIGHT,
	SCORE_MPC_WEIGHT,
	SIGNALS_METRIC_SETS,
	DEFAULT_SIGNALS_METRIC_SET,
	NEUTRAL_SCORES_FROM_ROUND,
	resolveScoringMode,
	scoringModesFor,
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
	const values = { alpha: 0.02, mpc: 0.03, ncorr: 0.05, nmmc: 0.01, corr20: 0.9, mmc: 0.9, corr60: 0.011, mmc60: 0.004 };

	it("scores corr60/mmc60 for 'classic', which is what Classic is paid on", () => {
		// Classic has no alpha/mpc at all, so scoring it on that pair produced
		// nothing — there was no Score to plot on a Classic chart.
		expect(computeChartScore('classic', values, 0.75, 2.25)).toBeCloseTo(
			0.75 * 0.011 + 2.25 * 0.004,
			12
		);
	});

	it("scores alpha/mpc for 'alpha_mpc'", () => {
		expect(computeChartScore('alpha_mpc', values, 0.3, 0.8)).toBeCloseTo(0.3 * 0.02 + 0.8 * 0.03, 12);
	});

	it("scores ncorr/nmmc for 'neutral'", () => {
		expect(computeChartScore('neutral', values, 0.5, 2)).toBeCloseTo(0.5 * 0.05 + 2 * 0.01, 12);
	});

	it("scores Crypto's corr/mmc, which has no 60-day pair at all", () => {
		// Crypto rounds carry corr and mmc only. Scoring them on corr60/mmc60 gave
		// null, so Crypto had no Score line to compare unstaked models with.
		const crypto = {
			alpha: null,
			mpc: null,
			ncorr: null,
			nmmc: null,
			corr20: 0.02,
			mmc: 0.01,
			corr60: null,
			mmc60: null
		};
		expect(computeChartScore('classic', crypto, 1, 2)).toBeCloseTo(1 * 0.02 + 2 * 0.01, 12);
	});

	it('prefers the 60-day pair when the tournament has one', () => {
		const classic = { alpha: null, mpc: null, ncorr: null, nmmc: null, corr20: 0.9, mmc: 0.9, corr60: 0.011, mmc60: 0.004 };
		expect(computeChartScore('classic', classic, 0.75, 2.25)).toBeCloseTo(0.75 * 0.011 + 2.25 * 0.004, 12);
	});

	it('returns null when both relevant components are absent', () => {
		expect(computeChartScore('neutral', { alpha: 1, mpc: 1, ncorr: null, nmmc: null, corr20: 1, mmc: 1, corr60: 1, mmc60: 1 }, 0.5, 2)).toBeNull();
		expect(computeChartScore('alpha_mpc', { alpha: null, mpc: null, ncorr: 1, nmmc: 1, corr20: 1, mmc: 1, corr60: 1, mmc60: 1 }, 0.3, 0.8)).toBeNull();
		expect(
			computeChartScore('classic', { alpha: 1, mpc: 1, ncorr: 1, nmmc: 1, corr20: null, mmc: null, corr60: null, mmc60: null }, 0.75, 2.25)
		).toBeNull();
	});
});

describe('scoringModesFor', () => {
	it('offers Classic only where there are no Signals metrics', () => {
		expect(scoringModesFor(false)).toEqual(['classic']);
	});

	it('drops Classic for Signals, which is no longer scored on corr60/mmc60', () => {
		expect(scoringModesFor(true)).toEqual(['alpha_mpc', 'neutral']);
	});
});

describe('resolveScoringMode', () => {
	it('keeps a mode the data still offers', () => {
		expect(resolveScoringMode('neutral', true)).toBe('neutral');
		expect(resolveScoringMode('classic', false)).toBe('classic');
	});

	it('moves off Classic when the data turns out to be Signals', () => {
		// Selecting a model of another tournament must not leave the chart on a
		// mode its own toggle no longer shows.
		expect(resolveScoringMode('classic', true)).toBe('alpha_mpc');
	});

	it('falls back to Classic when Signals metrics disappear', () => {
		expect(resolveScoringMode('neutral', false)).toBe('classic');
	});
});

describe('CLASSIC_SIXTY_DAY_FORMULA', () => {
	it("matches Numerai's Classic payout weighting since 28 Aug 2026", () => {
		// 3*CORR60 + 15*MMC60. Only valid against the 60-day pair — the rankings
		// pipeline still stores 20-day corr/mmc, so it keeps its own weights.
		expect(CLASSIC_SIXTY_DAY_FORMULA).toEqual({ corrWeight: 3, mmcWeight: 15 });
	});
});
