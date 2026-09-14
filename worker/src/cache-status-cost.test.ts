/**
 * What /rankings/cache-status costs D1. Every /rankings and /round-summary page
 * load calls it.
 *
 * Production still has the original (round_number, tournament) index: the swap
 * in migrations/0001 writes ~5M rows and does not fit D1's free plan. On that
 * index, MIN/MAX(round_number) for one tournament walks past every other
 * tournament's rows, so a Signals or Crypto page load read a large share of the
 * table — enough that a handful of views used up the day's 5M-row read quota.
 *
 * The budget here is stated in distinct rounds, not rows: the cost may grow
 * with how many rounds exist (~1.1k), never with how many models are scored in
 * them (~5k per round).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1CostHarness, type FleetSlice, type RoundIndexShape } from './test-support/d1-cost-harness';
import { getCacheStatus, type Env } from './rankings-api';

// Production's shape: Classic resolves later, so its latest round trails the
// others; Crypto's history starts later than Classic's.
const CLASSIC: FleetSlice = { tournament: 8, models: 150, fromRound: 900, toRound: 1330, unstakedEvery: 10 };
const SIGNALS: FleetSlice = { tournament: 11, models: 150, fromRound: 1100, toRound: 1354, unstakedEvery: 10 };
const CRYPTO: FleetSlice = { tournament: 12, models: 50, fromRound: 1150, toRound: 1354, unstakedEvery: 10 };
const FLEET = [CLASSIC, SIGNALS, CRYPTO];

const DISTINCT_ROUNDS = 1354 - 900 + 1;

const envFor = (db: D1Database) => ({ DB: db }) as unknown as Env;

// With no coverage row stored yet, a page load computes the span: one read of
// the (empty) coverage table, one read of sqlite_master to pick a strategy
// (about one read per schema object, bounded by the schema not the data), then
// the span query, which is what the budgets below are for.

describe.each<[string, RoundIndexShape, number]>([
	// Walking the round index costs a few reads per distinct round, at most.
	['production today, (round_number, tournament)', 'round_then_tournament', 4 * DISTINCT_ROUNDS],
	// A direct seek on each end of the tournament's rounds.
	['after migrations/0001, (tournament, round_number)', 'tournament_then_round', 6]
])('getCacheStatus on %s', (_label, shape, queryBudget) => {
	let d1: D1CostHarness;
	let schemaObjects = 0;

	beforeAll(async () => {
		d1 = await D1CostHarness.create();
		for (const slice of FLEET) await d1.seed(slice);
		await d1.setRoundIndex(shape);
		schemaObjects = await d1.schemaObjectCount();
	}, 60_000);

	afterAll(async () => {
		await d1?.dispose();
	});

	it.each(FLEET)('reports tournament $tournament exact round span', async (slice) => {
		const { result } = await d1.measure((db) => getCacheStatus(envFor(db), slice.tournament));
		expect(result).toEqual({
			tournament: slice.tournament,
			latestRound: slice.toRound,
			earliestRound: slice.fromRound
		});
	});

	it('reports nulls for a tournament with no rows', async () => {
		const { result } = await d1.measure((db) => getCacheStatus(envFor(db), 99));
		expect(result).toEqual({ tournament: 99, latestRound: null, earliestRound: null });
	});

	it.each(FLEET)(
		'reads within budget for tournament $tournament, independent of models per round',
		async (slice) => {
			const { cost } = await d1.measure((db) => getCacheStatus(envFor(db), slice.tournament));
			expect(cost.rowsRead).toBeLessThanOrEqual(1 + schemaObjects + queryBudget);
		}
	);

	it('never writes from the request path', async () => {
		const { cost } = await d1.measure((db) => getCacheStatus(envFor(db), CRYPTO.tournament));
		expect(cost.rowsWritten).toBe(0);
	});
});
