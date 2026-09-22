import { describe, expect, it } from 'vitest';
import { DEFAULT_STAKED_FILTER, passesStakedFilter } from './round-staked-filter.js';

describe('DEFAULT_STAKED_FILTER', () => {
	it("defaults to 'both' (no filtering — today's behaviour)", () => {
		expect(DEFAULT_STAKED_FILTER).toBe('both');
	});
});

describe('passesStakedFilter', () => {
	it("'both' shows every round regardless of staked status", () => {
		expect(passesStakedFilter(true, 'both')).toBe(true);
		expect(passesStakedFilter(false, 'both')).toBe(true);
		expect(passesStakedFilter(null, 'both')).toBe(true);
		expect(passesStakedFilter(undefined, 'both')).toBe(true);
	});

	it("'staked' shows only staked=true rounds", () => {
		expect(passesStakedFilter(true, 'staked')).toBe(true);
		expect(passesStakedFilter(false, 'staked')).toBe(false);
	});

	it("'unstaked' shows only staked=false rounds", () => {
		expect(passesStakedFilter(false, 'unstaked')).toBe(true);
		expect(passesStakedFilter(true, 'unstaked')).toBe(false);
	});

	it("rounds with no staked data (null/undefined) never pass 'staked' or 'unstaked'", () => {
		expect(passesStakedFilter(null, 'staked')).toBe(false);
		expect(passesStakedFilter(null, 'unstaked')).toBe(false);
		expect(passesStakedFilter(undefined, 'staked')).toBe(false);
		expect(passesStakedFilter(undefined, 'unstaked')).toBe(false);
	});
});
