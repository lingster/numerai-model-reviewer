/**
 * Signals is moving from alpha/mpc to the neutral scores (neutral correlation
 * and neutral contribution) for payouts from 25 September 2026. Both pairs are
 * published for the same rounds, so the app keeps both and the UI chooses.
 */
import { describe, expect, it } from 'vitest';
import {
	asMetricSet,
	defaultFormulaFor,
	defaultMetricSetFor,
	metricSetsFor,
	pickMetrics
} from './ranking';
import { SIGNALS_TOURNAMENT, CRYPTO_TOURNAMENT } from './mappers';

const CLASSIC_TOURNAMENT = 8;

const row = {
	model_name: 'm',
	corr: 0.01,
	mmc: 0.02,
	tc: 0.03,
	alpha: 0.04,
	mpc: 0.05,
	corr60: 0.08,
	mmc60: 0.09,
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

describe('Classic metric sets', () => {
	it('scores Classic on the 60-day pair by default, which is what it is paid on', () => {
		// 3*CORR60 + 15*MMC60 since 28 Aug 2026; the 20-day pair stays available.
		expect(defaultMetricSetFor(CLASSIC_TOURNAMENT)).toBe('corr60_mmc60');
		expect(pickMetrics(row, CLASSIC_TOURNAMENT, 'corr60_mmc60')).toEqual({
			corr: 0.08,
			mmc: 0.09,
			tc: 0.03
		});
	});

	it('still offers the 20-day pair Classic used to be scored on', () => {
		expect(metricSetsFor(CLASSIC_TOURNAMENT)).toEqual(['corr20_mmc', 'corr60_mmc60']);
		expect(pickMetrics(row, CLASSIC_TOURNAMENT, 'corr20_mmc')).toEqual({
			corr: 0.01,
			mmc: 0.02,
			tc: 0.03
		});
	});

	it('leaves Signals and Crypto with their own sets', () => {
		expect(metricSetsFor(SIGNALS_TOURNAMENT)).toEqual(['alpha_mpc', 'neutral']);
		expect(defaultMetricSetFor(SIGNALS_TOURNAMENT)).toBe('alpha_mpc');
		expect(metricSetsFor(CRYPTO_TOURNAMENT)).toEqual(['corr20_mmc']);
		expect(defaultMetricSetFor(CRYPTO_TOURNAMENT)).toBe('corr20_mmc');
	});
});

describe('defaultFormulaFor', () => {
	// What Numerai pays on, per tournament and pair. The API applies these when a
	// request sends no weights; sending Classic's at Crypto ranked it on a
	// formula nobody is paid by.
	it('weights Classic on its 60-day pair: 3*CORR60 + 15*MMC60', () => {
		expect(defaultFormulaFor(CLASSIC_TOURNAMENT, 'corr60_mmc60')).toEqual({
			corrWeight: 3,
			mmcWeight: 15,
			tcWeight: 0
		});
	});

	it("keeps Classic's older 20-day weighting for that pair", () => {
		expect(defaultFormulaFor(CLASSIC_TOURNAMENT, 'corr20_mmc')).toEqual({
			corrWeight: 0.75,
			mmcWeight: 2.25,
			tcWeight: 0
		});
	});

	it('weights Crypto 0.1*CORR + 1*MMC', () => {
		expect(defaultFormulaFor(CRYPTO_TOURNAMENT, 'corr20_mmc')).toEqual({
			corrWeight: 0.1,
			mmcWeight: 1,
			tcWeight: 0
		});
	});

	it('weights each Signals pair as Numerai pays it', () => {
		expect(defaultFormulaFor(SIGNALS_TOURNAMENT, 'alpha_mpc')).toEqual({
			corrWeight: 0.3,
			mmcWeight: 0.8,
			tcWeight: 0
		});
		expect(defaultFormulaFor(SIGNALS_TOURNAMENT, 'neutral')).toEqual({
			corrWeight: 0.5,
			mmcWeight: 2,
			tcWeight: 0
		});
	});
});
