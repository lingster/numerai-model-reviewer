/**
 * What the rankings queries cost D1, measured against a real (Miniflare) D1
 * with the production schema and a fleet in production's proportions.
 *
 * Why these exist: on D1's free tier (5M rows read / 100k written per day) a
 * single full-table scan of model_performances (~5M rows) is a whole day's read
 * budget, and running out of reads is what triggered the 2026-09 backfill
 * incidents. getCacheStatus has its own suite: cache-status-cost.test.ts.
 *
 * Budgets are stated relative to what a query returns, never to table size, so
 * they hold at any scale: a query may read its own tournament's matching rows,
 * but never another tournament's, and a lookup of one row may read about one row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1CostHarness, fleetModelName, type FleetSlice } from './test-support/d1-cost-harness';
import {
	maxRoundSql,
	selectRoundField,
	selectRoundFieldsInRange,
	selectTopModelByName
} from './perf-queries';
import { readMaxRound } from './refresh-floor';

// Production-shaped: Classic has the longest history, Crypto the shortest and
// smallest. Crypto starting later is what made MIN(round_number) scan everyone
// else's older rounds first.
const CLASSIC: FleetSlice = { tournament: 8, models: 150, fromRound: 900, toRound: 1354, unstakedEvery: 10 };
const SIGNALS: FleetSlice = { tournament: 11, models: 150, fromRound: 1100, toRound: 1354, unstakedEvery: 10 };
const CRYPTO: FleetSlice = { tournament: 12, models: 50, fromRound: 1150, toRound: 1354, unstakedEvery: 10 };

const stakedModels = (slice: FleetSlice): number => slice.models - Math.ceil(slice.models / slice.unstakedEvery);

/** An index range scan reads one entry past its last match to see the range ended. */
const RANGE_END_PROBE = 1;

let d1: D1CostHarness;

beforeAll(async () => {
	d1 = await D1CostHarness.create();
	for (const slice of [CLASSIC, SIGNALS, CRYPTO]) await d1.seed(slice);
}, 60_000);

afterAll(async () => {
	await d1?.dispose();
});

describe('selectRoundFieldsInRange (rolling-window rankings)', () => {
	const from = 1291;
	const to = 1350;
	const rounds = to - from + 1;

	it("returns only the tournament's staked rows in the window", async () => {
		const { result } = await d1.measure((db) => selectRoundFieldsInRange(db, from, to, 8));
		expect(result).toHaveLength(stakedModels(CLASSIC) * rounds);
		expect(result.every((r) => r.round_number >= from && r.round_number <= to)).toBe(true);
		expect(result.every((r) => (r.stake_value ?? 0) > 0)).toBe(true);
	});

	it("reads no other tournament's rows", async () => {
		const { cost } = await d1.measure((db) => selectRoundFieldsInRange(db, from, to, 8));
		// Its own rows in the window, staked or not — the stake test runs per row.
		expect(cost.rowsRead).toBeLessThanOrEqual(CLASSIC.models * rounds + RANGE_END_PROBE);
	});
});

describe('selectRoundField (single-round rankings)', () => {
	it('returns every staked model for the round', async () => {
		const { result } = await d1.measure((db) => selectRoundField(db, 1300, 11));
		expect(result).toHaveLength(stakedModels(SIGNALS));
	});

	it('keeps every Crypto row, which carries no stake data', async () => {
		const { result } = await d1.measure((db) => selectRoundField(db, 1300, 12));
		expect(result).toHaveLength(CRYPTO.models);
	});

	it("reads only that tournament's rows for that round", async () => {
		const { cost } = await d1.measure((db) => selectRoundField(db, 1300, 11));
		expect(cost.rowsRead).toBeLessThanOrEqual(SIGNALS.models + RANGE_END_PROBE);
	});
});

describe('max round (precompute incremental floor)', () => {
	const readerOn = (db: D1Database) => async (sql: string) =>
		(await db.prepare(sql).all<Record<string, unknown>>()).results;

	it.each([CLASSIC, SIGNALS, CRYPTO])('finds tournament $tournament latest round', async (slice) => {
		const { result } = await d1.measure((db) => readMaxRound(readerOn(db), slice.tournament));
		expect(result).toBe(slice.toRound);
	});

	it('reads a constant handful of rows', async () => {
		const { cost } = await d1.measure((db) => db.prepare(maxRoundSql(8)).all());
		expect(cost.rowsRead).toBeLessThanOrEqual(4);
	});
});

describe('selectTopModelByName (model-rank lookup)', () => {
	it('finds a model case-insensitively and returns its stored name', async () => {
		const name = fleetModelName(8, 42);
		const { result } = await d1.measure((db) => selectTopModelByName(db, name.toUpperCase(), 8));
		expect(result).toEqual({ model_id: 'id-8-42', model_name: name, username: 'user42' });
	});

	it('returns null for a model that is not in the staked set', async () => {
		const { result } = await d1.measure((db) => selectTopModelByName(db, 'no_such_model', 8));
		expect(result).toBeNull();
	});

	it('reads about one row, not every staked model', async () => {
		const { cost } = await d1.measure((db) => selectTopModelByName(db, fleetModelName(8, 42), 8));
		expect(cost.rowsRead).toBeLessThanOrEqual(2);
	});
});

describe('write cost', () => {
	it('keeps one model_performances row at table + primary key + round index', async () => {
		const { cost } = await d1.measure((db) =>
			db
				.prepare(
					`INSERT INTO model_performances
					   (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at)
					 VALUES ('write_probe', 1355, 0.1, 0.2, NULL, NULL, NULL, 1.0, 8, 0)`
				)
				.run()
		);
		// Table row + the primary key's index + the round index. Precompute stores
		// ~9.9k rows a day against a 100k/day free limit, so every extra index on
		// this table costs ~10% of the daily budget: idx_perf_model was dropped for
		// exactly that reason (migrations/0002), and adding one back would show here.
		expect(cost.rowsWritten).toBe(3);
	});
});
