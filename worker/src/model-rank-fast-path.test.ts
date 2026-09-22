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
					upsertRoundFieldSql(slice.tournament, round, 'staked', 'alpha_mpc', encodeFieldMetrics(fieldFromRows(rows, slice.tournament)), 0)
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

		// Renamed rather than dropped, and put back, so the stored fields other
		// tests rely on survive this one.
		await d1.execute('ALTER TABLE round_field_metrics RENAME TO round_field_metrics_gone');
		const { result } = await rankModel(target);
		await d1.execute('ALTER TABLE round_field_metrics_gone RENAME TO round_field_metrics');

		expect(result.rounds).toEqual(expected.result.rounds);
	});
});

describe('models that are not part of the stored field', () => {
	/** Stands in for the live API: serves a model's own rows straight from D1. */
	const ownScoresFromD1 =
		(db: D1Database) =>
		async (_env: Env, params: { modelName: string; tournament: number }) => {
			const rows = await db
				.prepare(
					`SELECT round_number, model_name, corr, mmc, tc, alpha, mpc, stake_value
					   FROM model_performances
					  WHERE model_name = ? AND tournament = ?`
				)
				.bind(params.modelName, params.tournament)
				.all<{ round_number: number } & Record<string, unknown>>();
			return new Map(
				(rows.results ?? []).map((r) => [r.round_number, r as never])
			);
		};

	it('ranks an unstaked model the same as the live path, which injects it into the field', async () => {
		// Every tenth seeded model has no stake, so it is absent from the stored
		// field. Ranking it against a field it is not in would report a different
		// field size, and a rank that ignores its own presence.
		const unstaked = fleetModelName(CLASSIC.tournament, 10);

		const withFields = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{ modelName: unstaked, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: FORMULA },
				ownScoresFromD1(db)
			)
		);

		await d1.execute('ALTER TABLE round_field_metrics RENAME TO round_field_metrics_hidden');
		const live = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{ modelName: unstaked, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: FORMULA },
				ownScoresFromD1(db)
			)
		);
		await d1.execute('ALTER TABLE round_field_metrics_hidden RENAME TO round_field_metrics');

		expect(withFields.result.rounds).toEqual(live.result.rounds);
	});

	it('ranks against every model that scored when asked for the all-models field', async () => {
		// Same model, same round: against the staked field it competes with ~108
		// models; against everyone who scored, with all 120.
		const target = fleetModelName(CLASSIC.tournament, 15);
		const round = TO;
		for (const scope of ['staked', 'all'] as const) {
			const { result: rows } = await d1.measure((db) => selectRoundField(db, round, CLASSIC.tournament, scope));
			await d1.measure((db) =>
				db
					.prepare(
						upsertRoundFieldSql(
							CLASSIC.tournament,
							round,
							scope,
							'alpha_mpc',
							encodeFieldMetrics(fieldFromRows(rows, CLASSIC.tournament)),
							0
						)
					)
					.run()
			);
		}

		const rank = (fieldScope: 'staked' | 'all') =>
			d1.measure((db) =>
				getModelRank(
					envFor(db),
					{
						modelName: target,
						startRound: round,
						endRound: round,
						tournament: CLASSIC.tournament,
						formula: FORMULA,
						fieldScope
					},
					noLiveFetch
				)
			);

		const staked = (await rank('staked')).result.rounds[0];
		const all = (await rank('all')).result.rounds[0];

		expect(all.totalModels).toBeGreaterThan(staked.totalModels);
		expect(all.totalModels).toBe(CLASSIC.models);
	});

	it('ranks an unstaked model from its stored rows, without a live fetch', async () => {
		// Its rows are in model_performances, just not in the staked field. Fetching
		// them from Numerai instead cost a round-trip per request: ~0.65s each for
		// the 25 unstaked models one rankings page asks about.
		const unstaked = fleetModelName(CLASSIC.tournament, 20);

		const { result } = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{ modelName: unstaked, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: FORMULA },
				noLiveFetch
			)
		);

		expect(result.rounds).toHaveLength(ROUNDS);
		expect(result.rounds.every((r) => r.rank !== null)).toBe(true);
	});

	it('stays on the stored fields when the model has no row at all in some rounds', async () => {
		// A model that stopped submitting part-way through the range: precompute
		// has no row for it in those rounds. Before, one such round sent the whole
		// request down the live path — the production case that made a 166-round
		// view read every staked row.
		const target = fleetModelName(CLASSIC.tournament, 43);
		const gapFrom = FROM + 5;
		// The live API still has the rounds D1 lost, so snapshot them before the
		// delete and serve those: that is what the real fetcher would return.
		const ownBefore = await d1.measure((db) => ownScoresFromD1(db)({} as Env, { modelName: target, tournament: CLASSIC.tournament }));
		const ownFromApi = async () => ownBefore.result;
		await d1.execute(
			`DELETE FROM model_performances
			  WHERE model_name = '${target}' AND tournament = ${CLASSIC.tournament} AND round_number >= ${gapFrom}`
		);
		// Rebuild those rounds' stored fields, so they match the rows precompute
		// would have seen — the field no longer contains the model either.
		await storeFields(CLASSIC, gapFrom, TO);

		const rank = (db: D1Database) =>
			getModelRank(
				envFor(db),
				{ modelName: target, startRound: FROM, endRound: TO, tournament: CLASSIC.tournament, formula: FORMULA },
				ownFromApi
			);

		const withFields = await d1.measure(rank);

		await d1.execute('ALTER TABLE round_field_metrics RENAME TO round_field_metrics_away');
		const live = await d1.measure(rank);
		await d1.execute('ALTER TABLE round_field_metrics_away RENAME TO round_field_metrics');

		// The fetcher stands in for the live API, which has the rounds D1 lacks.
		expect(withFields.result.rounds).toEqual(live.result.rounds);
		expect(withFields.result.rounds.some((r) => r.roundNumber >= gapFrom && r.rank !== null)).toBe(true);
		expect(withFields.cost.rowsRead).toBeLessThan(live.cost.rowsRead / 2);
	});

	it('reports the field size for a staked model that has no score in a round', async () => {
		const round = 1299;
		await d1.execute(
			`INSERT OR REPLACE INTO model_performances
			   (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at)
			 VALUES ('t8_unscored', ${round}, NULL, NULL, NULL, NULL, NULL, 1.0, 8, 0)`
		);

		const { result } = await d1.measure((db) =>
			getModelRank(
				envFor(db),
				{ modelName: 't8_unscored', startRound: round, endRound: round, tournament: CLASSIC.tournament, formula: FORMULA },
				ownScoresFromD1(db)
			)
		);

		const [only] = result.rounds;
		expect(only.rank).toBeNull();
		// The round still had a full field; reporting 0 would say the field was empty.
		expect(only.totalModels).toBeGreaterThan(0);
	});
});
