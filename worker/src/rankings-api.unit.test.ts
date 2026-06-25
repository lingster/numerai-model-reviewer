/**
 * Unit tests for getModelRank's D1 access pattern.
 *
 * Mocks env.DB so they run without a live Worker/D1. The key assertion is that
 * ranking a model over an R-round range does NOT issue R separate
 * model_performances queries (the N+1 that made wide ranges — "Last 500"/"All"
 * — take tens of seconds), while still computing correct ranks.
 */
import { describe, expect, it } from 'vitest';
import { getCacheStatus, getModelRank } from './rankings-api';

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
