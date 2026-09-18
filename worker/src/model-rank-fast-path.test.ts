/**
 * getModelRank served from stored per-round fields.
 *
 * The rankings page opens on the last 30 rounds with window=1. Ranking those
 * live reads every staked model's row for every round — ~300k reads for one
 * model at production scale. With the round's field stored as one row it is
 * about two reads per round.
 *
 * The bar is that nothing changes for the person looking at the page: the same
 * ranks, from the same data, whichever path produced them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1CostHarness, fleetModelName, type FleetSlice } from './test-support/d1-cost-harness';
import { bindingQuery } from './d1-query';
import { selectRoundField } from './perf-queries';
import { encodeFieldMetrics } from './round-field';
import { fieldFromRows, upsertRoundFieldSql } from './round-field-store';
import { refreshCoverage } from './tournament-coverage';
import { getModelRank, type Env, type ScoreFormula } from './rankings-api';

const CLASSIC: FleetSlice = { tournament: 8, models: 120, fromRound: 1200, toRound: 1300, unstakedEvery: 10 };
const SIGNALS: FleetSlice = { tournament: 11, models: 60, fromRound: 1250, toRound: 1300, unstakedEvery: 10 };
const FORMULA: ScoreFormula = { corrWeight: 0.75, mmcWeight: 2.25, tcWeight: 0 };

const FROM = 1271;
const TO = 1300;
const ROUNDS = TO - FROM + 1;

const envFor = (db: D1Database) => ({ DB: db, NUMERAI_API_URL: 'http://unused' }) as unknown as Env;
/** The unstaked-model fallback must never be reached for a staked model. */
const noLiveFetch = async () => {
	throw new Error('live performance fetch should not happen for a staked model');
};

let d1: D1CostHarness;

beforeAll(async () => {
	d1 = await D1CostHarness.create();
	for (const slice of [CLASSIC, SIGNALS]) await d1.seed(slice);
	await d1.setRoundIndex('round_then_tournament'); // production's index today
	await d1.measure((db) => refreshCoverage(bindingQuery(db), CLASSIC.tournament));
}, 60_000);

afterAll(async () => d1?.dispose());

const rankModel = (model: string, tournament = CLASSIC.tournament) =>
	d1.measure((db) =>
		getModelRank(
			envFor(db),
			{ modelName: model, startRound: FROM, endRound: TO, tournament, formula: FORMULA },
			noLiveFetch
		)
	);

async function storeFields(slice: FleetSlice, from: number, to: number): Promise<void> {
	for (let round = from; round <= to; round++) {
		const { result: rows } = await d1.measure((db) => selectRoundField(db, round, slice.tournament));
		await d1.measure((db) =>
			db
				.prepare(
					upsertRoundFieldSql(slice.tournament, round, encodeFieldMetrics(fieldFromRows(rows, slice.tournament)), 0)
				)
				.run()
		);
	}
}

describe('getModelRank with stored fields', () => {
	const target = fleetModelName(CLASSIC.tournament, 42);
	let live: Awaited<ReturnType<typeof rankModel>>;

	it('ranks live while no fields are stored, and reads the whole field to do it', async () => {
		live = await rankModel(target);
		expect(live.result.rounds).toHaveLength(ROUNDS);
		expect(live.result.rounds.every((r) => r.rank !== null)).toBe(true);
		// Every staked model's row, for every round in the range.
		expect(live.cost.rowsRead).toBeGreaterThan(CLASSIC.models * ROUNDS * 0.5);
	});

	it('returns exactly the same ranks once the fields are stored', async () => {
		await storeFields(CLASSIC, FROM, TO);
		const fast = await rankModel(target);
		expect(fast.result.rounds).toEqual(live.result.rounds);
	});

	it('costs about two reads per round instead of the whole field', async () => {
		const fast = await rankModel(target);
		expect(fast.cost.rowsRead).toBeLessThanOrEqual(2 * ROUNDS + 10);
		expect(fast.cost.rowsWritten).toBe(0);
	});

	it('agrees with the live path for the best and worst models too', async () => {
		for (const index of [0, 1, CLASSIC.models - 1]) {
			const model = fleetModelName(CLASSIC.tournament, index);
			const fast = await rankModel(model);
			const expected = await d1.measure((db) =>
				getModelRank(
					envFor(db),
					{ modelName: model, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: FORMULA },
					noLiveFetch
				)
			);
			expect(fast.result.rounds).toEqual(expected.result.rounds);
		}
	});

	it('honours custom weights against the stored metrics', async () => {
		const mmcOnly: ScoreFormula = { corrWeight: 0, mmcWeight: 1, tcWeight: 0 };
		const { result, cost } = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{ modelName: target, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: mmcOnly },
				noLiveFetch
			)
		);
		expect(result.rounds.every((r) => r.rank !== null)).toBe(true);
		expect(cost.rowsRead).toBeLessThanOrEqual(2 * ROUNDS + 10);
	});

	it('falls back to the live path for a trailing-window request', async () => {
		const { result, cost } = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{
					modelName: target,
					startRound: FROM,
					endRound: TO,
					tournament: CLASSIC.tournament,
					formula: FORMULA,
					window: 20
				},
				noLiveFetch
			)
		);
		expect(result.rounds).toHaveLength(ROUNDS);
		// Windowed ranking needs every model's history, which stored fields do not carry.
		expect(cost.rowsRead).toBeGreaterThan(2 * ROUNDS + 10);
	});

	it('falls back when a round in the range has no stored field yet', async () => {
		const { result, cost } = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{
					modelName: fleetModelName(SIGNALS.tournament, 3),
					startRound: FROM,
					endRound: TO,
					tournament: SIGNALS.tournament,
					formula: FORMULA
				},
				noLiveFetch
			)
		);
		expect(result.rounds).toHaveLength(ROUNDS);
		expect(cost.rowsRead).toBeGreaterThan(2 * ROUNDS + 10);
	});
});

describe('when the stored fields cannot be read', () => {
	it('still returns the live ranks rather than failing the request', async () => {
		const target = fleetModelName(CLASSIC.tournament, 7);
		const expected = await rankModel(target);
		await d1.execute('DROP TABLE round_field_metrics');

		const { result } = await rankModel(target);
		expect(result.rounds).toEqual(expected.result.rounds);
	});
});
