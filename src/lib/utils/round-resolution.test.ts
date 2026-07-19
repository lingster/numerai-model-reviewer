import { describe, it, expect } from 'vitest';
import {
	isRoundResolving,
	passesResolutionFilter,
	type ResolutionFilter
} from './round-resolution.js';

describe('isRoundResolving', () => {
	it('is true for rounds after the latest resolved round', () => {
		expect(isRoundResolving(1291, 1290)).toBe(true);
	});

	it('is false for the latest resolved round and earlier', () => {
		expect(isRoundResolving(1290, 1290)).toBe(false);
		expect(isRoundResolving(1200, 1290)).toBe(false);
	});

	it('treats everything as resolved when the boundary is unknown (null)', () => {
		expect(isRoundResolving(1291, null)).toBe(false);
	});
});

describe('passesResolutionFilter', () => {
	const cases: Array<[ResolutionFilter, number, boolean]> = [
		['both', 1291, true],
		['both', 1290, true],
		['resolved', 1290, true],
		['resolved', 1291, false],
		['resolving', 1291, true],
		['resolving', 1290, false]
	];
	for (const [filter, round, expected] of cases) {
		it(`${filter}: round ${round} -> ${expected}`, () => {
			expect(passesResolutionFilter(round, 1290, filter)).toBe(expected);
		});
	}

	it('with unknown boundary, resolved passes all and resolving passes none', () => {
		expect(passesResolutionFilter(1291, null, 'resolved')).toBe(true);
		expect(passesResolutionFilter(1291, null, 'resolving')).toBe(false);
		expect(passesResolutionFilter(1291, null, 'both')).toBe(true);
	});
});
