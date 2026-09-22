/**
 * Signals is moving from alpha/mpc to the neutral scores (neutral correlation
 * and neutral contribution) for payouts from 25 September 2026. Both pairs are
 * published for the same rounds, so the app keeps both and the UI chooses.
 */
import { describe, expect, it } from 'vitest';
import { asMetricSet, pickMetrics } from './ranking';
import { SIGNALS_TOURNAMENT, CRYPTO_TOURNAMENT } from './mappers';

const row = {
	model_name: 'm',
	corr: 0.01,
	mmc: 0.02,
	tc: 0.03,
	alpha: 0.04,
	mpc: 0.05,
	neutral_corr: 0.06,
	neutral_mmc: 0.07,
	stake_value: 1
};

describe('pickMetrics with a metric set', () => {
	it('scores Signals on alpha/mpc by default, as payouts do today', () => {
		expect(pickMetrics(row, SIGNALS_TOURNAMENT)).toEqual({ corr: 0.04, mmc: 0.05, tc: null });
	});

	it('scores Signals on the neutral pair when asked', () => {
		expect(pickMetrics(row, SIGNALS_TOURNAMENT, 'neutral')).toEqual({ corr: 0.06, mmc: 0.07, tc: null });
	});

	it('ignores the metric set for tournaments that have only one pair', () => {
		expect(pickMetrics(row, CRYPTO_TOURNAMENT, 'neutral')).toEqual({ corr: 0.01, mmc: 0.02, tc: 0.03 });
	});
});

describe('asMetricSet', () => {
	it('accepts the known sets and falls back for anything else', () => {
		expect(asMetricSet('neutral')).toBe('neutral');
		expect(asMetricSet('alpha_mpc')).toBe('alpha_mpc');
		expect(asMetricSet('nonsense')).toBe('alpha_mpc');
		expect(asMetricSet(null)).toBe('alpha_mpc');
	});
});
