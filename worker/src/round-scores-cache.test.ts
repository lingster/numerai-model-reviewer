/**
 * Unit tests for the incremental round-scores cache.
 *
 * The upstream submissionScores query returns a model's whole scored history
 * (~420KB) and cannot be asked for one round, so what keeps this cheap is (a)
 * only fetching rounds we don't have, and (b) only writing rows that changed.
 * These tests pin both.
 */
import { describe, it, expect } from 'vitest';
import {
	computeFetchWindow,
	diffRoundScores,
	MUTABLE_ROUND_WINDOW,
	TAIL_REFRESH_SECONDS,
	type Coverage,
	type RoundScores
} from './round-scores-cache';

const MAX_WINDOW = 1000;
const NOW = 1_700_000_000;

const scores = (mmc60: number | null, alpha: number | null = null, mpc: number | null = null): RoundScores => ({
	corr: null,
	mmc: null,
	mmc60,
	alpha,
	mpc
});

const coverage = (toRound: number, updatedAt: number, fromRound = 350): Coverage => ({
	fromRound,
	toRound,
	updatedAt
});

describe('computeFetchWindow', () => {
	it('takes the whole history when the model has never been fetched', () => {
		expect(computeFetchWindow(null, 1344, MAX_WINDOW, NOW)).toBe(MAX_WINDOW);
	});

	it('serves entirely from cache when nothing is new and the tail is fresh', () => {
		const cov = coverage(1344, NOW - 60);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBeNull();
	});

	it('refreshes just the mutable tail once the cached tail goes stale', () => {
		const cov = coverage(1344, NOW - TAIL_REFRESH_SECONDS - 1);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBe(MUTABLE_ROUND_WINDOW);
	});

	it('covers rounds opened since the watermark, plus the mutable tail', () => {
		const cov = coverage(1330, NOW - 60);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBe(14 + MUTABLE_ROUND_WINDOW);
	});

	it('fetches new rounds even when the tail was refreshed moments ago', () => {
		const cov = coverage(1343, NOW);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBe(1 + MUTABLE_ROUND_WINDOW);
	});

	it('never exceeds the maximum window', () => {
		const cov = coverage(10, NOW - 60);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBe(MAX_WINDOW);
	});

	it('does not go backwards when coverage is ahead of the latest round', () => {
		const cov = coverage(1345, NOW - TAIL_REFRESH_SECONDS - 1);
		expect(computeFetchWindow(cov, 1344, MAX_WINDOW, NOW)).toBe(MUTABLE_ROUND_WINDOW);
	});
});

describe('diffRoundScores', () => {
	it('writes nothing when every fetched round already matches the cache', () => {
		const cached = new Map([
			[1343, scores(0.01)],
			[1344, scores(0.02)]
		]);
		const fresh = new Map([
			[1343, scores(0.01)],
			[1344, scores(0.02)]
		]);
		expect(diffRoundScores(cached, fresh).size).toBe(0);
	});

	it('writes only the rounds whose values moved', () => {
		const cached = new Map([
			[1343, scores(0.01)],
			[1344, scores(0.02)]
		]);
		const fresh = new Map([
			[1343, scores(0.01)],
			[1344, scores(0.05)]
		]);
		const changed = diffRoundScores(cached, fresh);
		expect([...changed.keys()]).toEqual([1344]);
	});

	it('writes rounds that are not cached yet', () => {
		const changed = diffRoundScores(new Map(), new Map([[1345, scores(0.03)]]));
		expect([...changed.keys()]).toEqual([1345]);
	});

	it('skips rounds with no scores at all, so unscored rounds cost no rows', () => {
		const fresh = new Map([
			[1200, scores(null)],
			[1201, scores(null)],
			[1202, scores(0.01)]
		]);
		const changed = diffRoundScores(new Map(), fresh);
		expect([...changed.keys()]).toEqual([1202]);
	});

	it('treats a round scored only on corr/mmc (Crypto) as worth a row', () => {
		const fresh = new Map([[1104, { corr: 0.037, mmc: 0.03, mmc60: null, alpha: null, mpc: null }]]);
		expect(diffRoundScores(new Map(), fresh).size).toBe(1);
	});

	it('detects a change in any one metric', () => {
		const cached = new Map([[1344, scores(null, 0.01, 0.02)]]);
		const fresh = new Map([[1344, scores(null, 0.01, 0.03)]]);
		expect(diffRoundScores(cached, fresh).size).toBe(1);
	});
});
