import { describe, expect, it } from 'vitest';
import type { RoundModelScore } from '$lib/types.js';
import { metricLabel, metricOptions, metricValue } from './round-summary-metric.js';

const CLASSIC = 8;
const SIGNALS = 11;

function model(partial: Partial<RoundModelScore>): RoundModelScore {
	return {
		modelId: '',
		modelName: 'm',
		username: 'u',
		roundNumber: 1000,
		corr: 0.01,
		mmc: 0.02,
		tc: null,
		stakeValue: null,
		customScore: 0.05,
		rank: 1,
		totalModels: 200,
		...partial
	};
}

describe('metricOptions / metricLabel', () => {
	it('labels CORR/MMC for Classic', () => {
		expect(metricOptions(CLASSIC).map((o) => o.label)).toEqual([
			'CORR',
			'MMC',
			'Payout score',
			'Percentile'
		]);
	});

	it('labels Alpha/MPC for Signals', () => {
		expect(metricOptions(SIGNALS).map((o) => o.label)).toEqual([
			'Alpha',
			'MPC',
			'Payout score',
			'Percentile'
		]);
	});

	it('metricLabel resolves a single key', () => {
		expect(metricLabel('metric1', SIGNALS)).toBe('Alpha');
		expect(metricLabel('metric2', CLASSIC)).toBe('MMC');
	});
});

describe('metricValue', () => {
	it('reads corr/mmc/customScore', () => {
		const m = model({ corr: 0.03, mmc: 0.04, customScore: 0.07 });
		expect(metricValue(m, 'metric1')).toBe(0.03);
		expect(metricValue(m, 'metric2')).toBe(0.04);
		expect(metricValue(m, 'score')).toBe(0.07);
	});

	it('derives percentile from rank + totalModels (best rank → 100)', () => {
		expect(metricValue(model({ rank: 1, totalModels: 200 }), 'percentile')).toBeCloseTo(100, 6);
	});

	it('returns null when the underlying field is null', () => {
		expect(metricValue(model({ mmc: null }), 'metric2')).toBeNull();
		expect(metricValue(model({ rank: null }), 'percentile')).toBeNull();
	});
});
