/**
 * Unit tests for getModelRank's D1 access pattern.
 *
 * Mocks env.DB so they run without a live Worker/D1. The key assertion is that
 * ranking a model over an R-round range does NOT issue R separate
 * model_performances queries (the N+1 that made wide ranges — "Last 500"/"All"
 * — take tens of seconds), while still computing correct ranks.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	getCacheStatus,
	getModelRank,
	computeLatestResolvedRound,
	type OwnPerformanceFetcher
} from './rankings-api';

/** Build an own-scores row for the injection fetcher. */
function ownRow(corr: number, mmc: number) {
	return { model_name: 'target', corr, mmc, tc: null, alpha: null, mpc: null, stake_value: null };
}

describe('computeLatestResolvedRound', () => {
	it('returns the highest round with resolvedGeneral=true', () => {
		const rounds = [
			{ number: 1314, resolvedGeneral: false },
			{ number: 1291, resolvedGeneral: false },
			{ number: 1290, resolvedGeneral: true },
			{ number: 1289, resolvedGeneral: true }
		];
		expect(computeLatestResolvedRound(rounds)).toBe(1290);
	});

	it('ignores order (picks the max, not the first)', () => {
		const rounds = [
			{ number: 1200, resolvedGeneral: true },
			{ number: 1290, resolvedGeneral: true },
			{ number: 1250, resolvedGeneral: true }
		];
		expect(computeLatestResolvedRound(rounds)).toBe(1290);
	});

	it('returns null when nothing is resolved', () => {
		expect(computeLatestResolvedRound([{ number: 5, resolvedGeneral: false }])).toBeNull();
	});

	it('returns null for an empty list', () => {
		expect(computeLatestResolvedRound([])).toBeNull();
	});
});

type Row = {
	round_number: number;
	model_name: string;
	corr: number | null;
	mmc: number | null;
	tc: number | null;
	alpha: number | null;
	mpc: number | null;
	stake_value: number | null;
};

const FORMULA = { corrWeight: 1, mmcWeight: 1, tcWeight: 0 };

/**
 * Mock D1 that serves `rows` for model_performances queries (handling both the
 * per-round `= ?` form and the batched `BETWEEN ? AND ?` form) and a fixed meta
 * row for the top_staked_models lookup. Records how many performance queries ran.
 */
function mockEnv(rows: Row[]) {
	const perfQueries: Array<number[]> = [];
	const DB = {
		prepare(sql: string) {
			const isPerf = /model_performances/i.test(sql);
			const isRange = /between/i.test(sql);
			return {
				bind(...args: unknown[]) {
					return {
						all: async () => {
							if (!isPerf) return { results: [] };
							if (isRange) {
								const [lo, hi] = args as number[];
								perfQueries.push([lo, hi]);
								return { results: rows.filter((r) => r.round_number >= lo && r.round_number <= hi) };
							}
							const [round] = args as number[];
							perfQueries.push([round]);
							return { results: rows.filter((r) => r.round_number === round) };
						},
						first: async () => {
							// top_staked_models lookup
							const [name] = args as string[];
							return { model_id: 'mid', model_name: name, username: 'owner' };
						}
					};
				}
			};
		}
	};
	return { env: { DB } as unknown as Env, perfQueries };
}

type Env = Parameters<typeof getModelRank>[0];

function row(round: number, model: string, corr: number, mmc: number): Row {
	return { round_number: round, model_name: model, corr, mmc, tc: null, alpha: null, mpc: null, stake_value: 1 };
}

describe('getModelRank D1 access pattern', () => {
	it('computes correct ranks across rounds', async () => {
		// Round 100: target=2nd (score 0.4 vs b 0.6). Round 101: target=1st.
		const rows = [
			row(100, 'target', 0.2, 0.2), // score 0.4
			row(100, 'b', 0.3, 0.3), // score 0.6
			row(101, 'target', 0.5, 0.5), // score 1.0
			row(101, 'b', 0.1, 0.1) // score 0.2
		];
		const { env } = mockEnv(rows);

		const res = await getModelRank(env, {
			modelName: 'target',
			startRound: 100,
			endRound: 101,
			tournament: 8,
			formula: FORMULA
		});

		expect(res.rounds.find((r) => r.roundNumber === 100)?.rank).toBe(2);
		expect(res.rounds.find((r) => r.roundNumber === 101)?.rank).toBe(1);
	});

	it('does not issue one query per round over a wide range', async () => {
		const rows = [row(100, 'target', 0.2, 0.2), row(300, 'target', 0.2, 0.2)];
		const { env, perfQueries } = mockEnv(rows);

		const ROUNDS = 250; // 100..349
		await getModelRank(env, {
			modelName: 'target',
			startRound: 100,
			endRound: 100 + ROUNDS - 1,
			tournament: 8,
			formula: FORMULA
		});

		// The N+1 would be ~250 queries; batched access must be far fewer.
		expect(perfQueries.length).toBeLessThan(ROUNDS / 10);
		// And every requested round must still be covered by the fetched ranges.
		const covered = perfQueries.every((q) => q.length === 2);
		expect(covered).toBe(true);
	});
});

describe('getModelRank unstaked-model support', () => {
	// A staked field of two other models; the target is NOT staked (absent from D1).
	const stakedField = [row(100, 'b', 0.3, 0.3), row(100, 'c', 0.1, 0.1)];

	it('ranks an unstaked model by injecting its own scores into the field', async () => {
		const { env } = mockEnv(stakedField);
		// Own score 0.25+0.25 = 0.5 places target between c (0.2) and b (0.6): 2nd of 3.
		const fetchOwn: OwnPerformanceFetcher = async () => new Map([[100, ownRow(0.25, 0.25)]]);

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 100, endRound: 100, tournament: 8, formula: FORMULA },
			fetchOwn
		);

		const r100 = res.rounds.find((r) => r.roundNumber === 100);
		expect(r100?.rank).toBe(2);
		expect(r100?.totalModels).toBe(3); // two staked + the injected target
		expect(r100?.customScore).toBeCloseTo(0.5);
	});

	it('does NOT fetch own scores when the model is already in the staked field', async () => {
		const { env } = mockEnv([row(100, 'target', 0.5, 0.5), row(100, 'b', 0.1, 0.1)]);
		const fetchOwn = vi.fn<OwnPerformanceFetcher>(async () => new Map());

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 100, endRound: 100, tournament: 8, formula: FORMULA },
			fetchOwn
		);

		expect(res.rounds.find((r) => r.roundNumber === 100)?.rank).toBe(1);
		expect(fetchOwn).not.toHaveBeenCalled(); // pure-D1 fast path preserved
	});

	it('does not fabricate a rank for rounds with no staked field (no-data)', async () => {
		const { env } = mockEnv(stakedField); // only round 100 has a field
		const fetchOwn: OwnPerformanceFetcher = async () =>
			new Map([
				[100, ownRow(0.25, 0.25)],
				[101, ownRow(0.9, 0.9)]
			]);

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 100, endRound: 101, tournament: 8, formula: FORMULA },
			fetchOwn
		);

		expect(res.rounds.find((r) => r.roundNumber === 100)?.rank).toBe(2);
		// Round 101 has no staked field to rank against — must stay unranked, not 1/1.
		const r101 = res.rounds.find((r) => r.roundNumber === 101);
		expect(r101?.rank).toBeNull();
		expect(r101?.totalModels).toBe(0);
	});

	it('handles a model staked in some rounds and unstaked in others', async () => {
		// Round 100: target staked (in field). Round 101: target absent, own scores inject it.
		const rows = [
			row(100, 'target', 0.5, 0.5),
			row(100, 'b', 0.1, 0.1),
			row(101, 'b', 0.3, 0.3),
			row(101, 'c', 0.1, 0.1)
		];
		const { env } = mockEnv(rows);
		const fetchOwn: OwnPerformanceFetcher = async () => new Map([[101, ownRow(0.25, 0.25)]]);

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 100, endRound: 101, tournament: 8, formula: FORMULA },
			fetchOwn
		);

		expect(res.rounds.find((r) => r.roundNumber === 100)?.rank).toBe(1);
		expect(res.rounds.find((r) => r.roundNumber === 101)?.rank).toBe(2);
	});

	it('ranks an injected unstaked model under windowed averaging', async () => {
		// window=2 averages each model's trailing two rounds, then scores corr+mmc.
		// @r101: c avg=0.5/0.5 → score 1.0; target avg=0.15/0.15 → score 0.3;
		// b avg=0.1/0.1 → score 0.2. Ranking c > target > b: target is 2nd of 3.
		const rows = [
			row(100, 'b', 0.1, 0.1),
			row(100, 'c', 0.5, 0.5),
			row(101, 'b', 0.1, 0.1),
			row(101, 'c', 0.5, 0.5)
		];
		const { env } = mockEnv(rows);
		const fetchOwn: OwnPerformanceFetcher = async () =>
			new Map([
				[100, ownRow(0.1, 0.1)],
				[101, ownRow(0.2, 0.2)]
			]);

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 101, endRound: 101, tournament: 8, formula: FORMULA, window: 2 },
			fetchOwn
		);

		const r101 = res.rounds.find((r) => r.roundNumber === 101);
		expect(r101?.rank).toBe(2);
		expect(r101?.totalModels).toBe(3);
	});

	it('leaves the model unranked when its own scores cannot be fetched', async () => {
		const { env } = mockEnv(stakedField);
		const fetchOwn: OwnPerformanceFetcher = async () => new Map(); // e.g. never submitted

		const res = await getModelRank(
			env,
			{ modelName: 'target', startRound: 100, endRound: 100, tournament: 8, formula: FORMULA },
			fetchOwn
		);

		const r100 = res.rounds.find((r) => r.roundNumber === 100);
		expect(r100?.rank).toBeNull();
		expect(r100?.totalModels).toBe(2); // field still reported so the UI can explain "not staked"
	});
});

/** Mock env whose model_performances MAX/MIN aggregate returns the given row. */
function mockAggEnv(agg: { latestRound: number | null; earliestRound: number | null } | null) {
	const DB = {
		prepare() {
			return {
				bind() {
					return { first: async () => agg };
				}
			};
		}
	};
	return { DB } as unknown as Env;
}

describe('getCacheStatus', () => {
	it('reports the cache round coverage for a tournament', async () => {
		const env = mockAggEnv({ latestRound: 1272, earliestRound: 800 });
		const status = await getCacheStatus(env, 8);
		expect(status).toEqual({ tournament: 8, latestRound: 1272, earliestRound: 800 });
	});

	it('returns null bounds when the cache is empty for the tournament', async () => {
		const env = mockAggEnv({ latestRound: null, earliestRound: null });
		const status = await getCacheStatus(env, 12);
		expect(status).toEqual({ tournament: 12, latestRound: null, earliestRound: null });
	});

	it('tolerates a missing aggregate row', async () => {
		const env = mockAggEnv(null);
		const status = await getCacheStatus(env, 11);
		expect(status).toEqual({ tournament: 11, latestRound: null, earliestRound: null });
	});
});
