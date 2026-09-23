import { describe, expect, it } from 'vitest';
import { firstRankedRound, metricCoverageNotice } from './metric-coverage';

const ranked = (roundNumber: number, rank: number | null) => ({ roundNumber, rank });

describe('firstRankedRound', () => {
	it('finds the first round the model actually has a rank for', () => {
		expect(firstRankedRound([ranked(100, null), ranked(101, null), ranked(102, 5)])).toBe(102);
	});

	it('is null when every round is ranked (nothing missing to report)', () => {
		expect(firstRankedRound([ranked(100, 3), ranked(101, 5)])).toBeNull();
	});

	it('is null when nothing is ranked at all — that is a different problem', () => {
		// An empty range, or a metric the model has none of: saying "data starts
		// at X" would be a lie when there is no X.
		expect(firstRankedRound([ranked(100, null), ranked(101, null)])).toBeNull();
	});
});

describe('metricCoverageNotice', () => {
	const rounds = [ranked(900, null), ranked(901, null), ranked(940, 12)];

	it('names the pair and the round its data starts at', () => {
		expect(metricCoverageNotice('corr60_mmc60', rounds)).toBe(
			'No CORR60/MMC60 data before round 940 — earlier rounds have no rank on this pair.'
		);
	});

	it('says nothing when the range is fully covered', () => {
		expect(metricCoverageNotice('corr60_mmc60', [ranked(940, 12)])).toBeNull();
	});

	it('works for any pair, not just the 60-day one', () => {
		expect(metricCoverageNotice('neutral', rounds)).toContain('NCORR/NMMC');
	});
});
