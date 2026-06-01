import { describe, expect, it } from 'vitest';
import { roundRangeToDates } from './round-date.js';

const ROUNDS = [
	{ roundNumber: 1276, roundOpenTime: '2026-05-26T12:00:00Z' },
	{ roundNumber: 1277, roundOpenTime: '2026-05-27T12:00:00Z' },
	{ roundNumber: 1278, roundOpenTime: '2026-05-28T12:00:00Z' }
];

describe('roundRangeToDates', () => {
	it('maps exact round numbers to their open dates (UTC)', () => {
		expect(roundRangeToDates(ROUNDS, 1277, 1278)).toEqual({
			startDate: '2026-05-27',
			endDate: '2026-05-28'
		});
	});

	it('clamps a startRound below the available range to the earliest round', () => {
		expect(roundRangeToDates(ROUNDS, 1000, 1278).startDate).toBe('2026-05-26');
	});

	it('clamps an endRound above the available range to the latest round', () => {
		expect(roundRangeToDates(ROUNDS, 1277, 9999).endDate).toBe('2026-05-28');
	});

	it('uses the nearest round at or after startRound when the exact round is missing', () => {
		// 1276.5 doesn't exist; start should snap up to 1277.
		expect(roundRangeToDates(ROUNDS, 1276.5 as unknown as number, undefined).startDate).toBe(
			'2026-05-27'
		);
	});

	it('ignores rounds without an open time', () => {
		const rounds = [
			{ roundNumber: 1276, roundOpenTime: null },
			{ roundNumber: 1277, roundOpenTime: '2026-05-27T12:00:00Z' }
		];
		expect(roundRangeToDates(rounds, 1276, 1277)).toEqual({
			startDate: '2026-05-27',
			endDate: '2026-05-27'
		});
	});

	it('returns an empty object when no rounds carry a timestamp', () => {
		expect(roundRangeToDates([{ roundNumber: 1, roundOpenTime: null }], 1, 1)).toEqual({});
	});

	it('omits a bound that was not requested', () => {
		expect(roundRangeToDates(ROUNDS, undefined, 1277)).toEqual({ endDate: '2026-05-27' });
		expect(roundRangeToDates(ROUNDS, 1277, undefined)).toEqual({ startDate: '2026-05-27' });
	});
});
