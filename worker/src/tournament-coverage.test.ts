/**
 * The tournament_coverage table: one row per tournament holding the first and
 * last round stored in model_performances, so a page load reads one row.
 *
 * Precompute owns the row. After each store it recomputes the span from the
 * table itself — exact whatever the run did (incremental, backfill or reset) —
 * then writes it. The worker only reads it, and computes the span on the fly
 * when no row exists yet (the first deploy, before precompute's next run).
 *
 * Computing the span must be cheap on both index shapes, and must refuse
 * rather than fall back to a full scan when there is no round index at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1CostHarness, type FleetSlice, type RoundIndexShape } from './test-support/d1-cost-harness';
import { bindingQuery } from './d1-query';
import {
	computeRoundSpan,
	getRoundCoverage,
	NoRoundIndexError,
	readStoredCoverage,
	refreshCoverage
} from './tournament-coverage';

const CLASSIC: FleetSlice = { tournament: 8, models: 150, fromRound: 900, toRound: 1330, unstakedEvery: 10 };
const SIGNALS: FleetSlice = { tournament: 11, models: 150, fromRound: 1100, toRound: 1354, unstakedEvery: 10 };
const CRYPTO: FleetSlice = { tournament: 12, models: 50, fromRound: 1150, toRound: 1354, unstakedEvery: 10 };
const FLEET = [CLASSIC, SIGNALS, CRYPTO];

const DISTINCT_ROUNDS = 1354 - 900 + 1;

const spanOf = (slice: FleetSlice) => ({ earliestRound: slice.fromRound, latestRound: slice.toRound });

// Budgets below are for the span query itself. Choosing a strategy also reads
// sqlite_master once, which costs about one read per schema object — bounded by
// the schema, never by the data — and is added on top.

async function fleetDatabase(shape: RoundIndexShape): Promise<D1CostHarness> {
	const d1 = await D1CostHarness.create();
	for (const slice of FLEET) await d1.seed(slice);
	await d1.setRoundIndex(shape);
	return d1;
}

describe.each<[string, RoundIndexShape, number]>([
	['production today, (round_number, tournament)', 'round_then_tournament', 4 * DISTINCT_ROUNDS],
	['after migrations/0001, (tournament, round_number)', 'tournament_then_round', 6]
])('computeRoundSpan on %s', (_label, shape, queryBudget) => {
	let d1: D1CostHarness;
	let schemaObjects = 0;
	beforeAll(async () => {
		d1 = await fleetDatabase(shape);
		schemaObjects = await d1.schemaObjectCount();
	}, 60_000);
	afterAll(async () => d1?.dispose());

	it.each(FLEET)('finds tournament $tournament exact span', async (slice) => {
		const { result } = await d1.measure((db) => computeRoundSpan(bindingQuery(db), slice.tournament));
		expect(result).toEqual(spanOf(slice));
	});

	it('returns null for a tournament with no rows', async () => {
		const { result } = await d1.measure((db) => computeRoundSpan(bindingQuery(db), 99));
		expect(result).toBeNull();
	});

	it.each(FLEET)('reads within budget for tournament $tournament', async (slice) => {
		const { cost } = await d1.measure((db) => computeRoundSpan(bindingQuery(db), slice.tournament));
		expect(cost.rowsRead).toBeLessThanOrEqual(schemaObjects + queryBudget);
	});
});

describe('computeRoundSpan with no round index', () => {
	let d1: D1CostHarness;
	let schemaObjects = 0;
	beforeAll(async () => {
		d1 = await fleetDatabase('none');
		schemaObjects = await d1.schemaObjectCount();
	}, 60_000);
	afterAll(async () => d1?.dispose());

	it('refuses instead of scanning the whole table', async () => {
		const { result, cost } = await d1.measure((db) =>
			computeRoundSpan(bindingQuery(db), CRYPTO.tournament).catch((error: unknown) => error)
		);
		expect(result).toBeInstanceOf(NoRoundIndexError);
		// Only the schema lookup; not a single model_performances row.
		expect(cost.rowsRead).toBeLessThanOrEqual(schemaObjects);
	});
});

describe('refreshCoverage and getRoundCoverage', () => {
	let d1: D1CostHarness;
	beforeAll(async () => {
		d1 = await fleetDatabase('round_then_tournament');
	}, 60_000);
	afterAll(async () => d1?.dispose());

	it('computes the span on the fly, without writing, when nothing is stored yet', async () => {
		const { result, cost } = await d1.measure((db) => getRoundCoverage(bindingQuery(db), SIGNALS.tournament));
		expect(result).toEqual(spanOf(SIGNALS));
		expect(cost.rowsWritten).toBe(0);
	});

	it('stores the exact span in one row', async () => {
		const { result, cost } = await d1.measure((db) => refreshCoverage(bindingQuery(db), CRYPTO.tournament, 1_700_000_000));
		expect(result).toEqual(spanOf(CRYPTO));
		// INSERT OR REPLACE on an existing row is a delete plus an insert.
		expect(cost.rowsWritten).toBeLessThanOrEqual(2);

		const stored = await d1.measure((db) => readStoredCoverage(bindingQuery(db), CRYPTO.tournament));
		expect(stored.result).toEqual(spanOf(CRYPTO));
	});

	it('serves a page load from the stored row: one read, no writes', async () => {
		await d1.measure((db) => refreshCoverage(bindingQuery(db), CLASSIC.tournament));
		const { result, cost } = await d1.measure((db) => getRoundCoverage(bindingQuery(db), CLASSIC.tournament));
		expect(result).toEqual(spanOf(CLASSIC));
		expect(cost.rowsRead).toBeLessThanOrEqual(2);
		expect(cost.rowsWritten).toBe(0);
	});

	it('picks up rounds written since the last refresh', async () => {
		await d1.measure((db) => refreshCoverage(bindingQuery(db), CLASSIC.tournament));
		await d1.seed({ ...CLASSIC, fromRound: 1331, toRound: 1331 });

		const { result } = await d1.measure((db) => refreshCoverage(bindingQuery(db), CLASSIC.tournament));
		expect(result).toEqual({ earliestRound: CLASSIC.fromRound, latestRound: 1331 });
	});

	it('follows a reset that removed old rounds, rather than keeping the old earliest', async () => {
		await d1.measure((db) => refreshCoverage(bindingQuery(db), SIGNALS.tournament));
		await d1.execute('DELETE FROM model_performances WHERE tournament = 11 AND round_number < 1200');

		const { result } = await d1.measure((db) => refreshCoverage(bindingQuery(db), SIGNALS.tournament));
		expect(result).toEqual({ earliestRound: 1200, latestRound: SIGNALS.toRound });
	});

	it('clears the stored row when a tournament has no rows left', async () => {
		await d1.measure((db) => refreshCoverage(bindingQuery(db), CRYPTO.tournament));
		await d1.execute('DELETE FROM model_performances WHERE tournament = 12');

		const refreshed = await d1.measure((db) => refreshCoverage(bindingQuery(db), CRYPTO.tournament));
		expect(refreshed.result).toBeNull();

		const stored = await d1.measure((db) => readStoredCoverage(bindingQuery(db), CRYPTO.tournament));
		expect(stored.result).toBeNull();
	});

	it('rejects a non-integer tournament rather than interpolating it into SQL', async () => {
		await expect(d1.measure((db) => computeRoundSpan(bindingQuery(db), 8.5))).rejects.toThrow(/tournament/);
	});
});

describe('getRoundCoverage without the coverage table', () => {
	let d1: D1CostHarness;
	beforeAll(async () => {
		d1 = await fleetDatabase('round_then_tournament');
		await d1.execute('DROP TABLE tournament_coverage');
	}, 60_000);
	afterAll(async () => d1?.dispose());

	it('still answers, e.g. when the deploy\'s schema step failed', async () => {
		const { result, cost } = await d1.measure((db) => getRoundCoverage(bindingQuery(db), CLASSIC.tournament));
		expect(result).toEqual(spanOf(CLASSIC));
		expect(cost.rowsWritten).toBe(0);
	});
});
