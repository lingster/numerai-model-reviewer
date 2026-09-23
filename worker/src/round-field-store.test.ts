/**
 * Storing and reading per-round fields, and choosing which rounds to backfill.
 *
 * The backfill walks backwards from the newest round a tournament has, a fixed
 * number of rounds per run, so history is covered within D1's free daily limits
 * instead of all at once. Newest first, because the rankings page opens on the
 * most recent 30 rounds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1CostHarness, type FleetSlice } from './test-support/d1-cost-harness';
import { bindingQuery } from './d1-query';
import { selectRoundField } from './perf-queries';
import { pickMetrics } from './ranking';
import { decodeFieldMetrics, encodeFieldMetrics, rankInField } from './round-field';
import {
	fieldFromRows,
	readStoredFields,
	readStoredRounds,
	roundsToBackfill,
	upsertRoundFieldSql
} from './round-field-store';
import type { RoundPerfRow } from './perf-queries';

const CLASSIC: FleetSlice = { tournament: 8, models: 120, fromRound: 1200, toRound: 1300, unstakedEvery: 10 };
const SIGNALS: FleetSlice = { tournament: 11, models: 80, fromRound: 1250, toRound: 1300, unstakedEvery: 10 };
const FORMULA = { corrWeight: 0.75, mmcWeight: 2.25, tcWeight: 0 };

const stakedCount = (slice: FleetSlice) => slice.models - Math.ceil(slice.models / slice.unstakedEvery);

describe('roundsToBackfill', () => {
	const span = { earliestRound: 100, latestRound: 200 };

	it('starts from the newest round when nothing is stored', () => {
		expect(roundsToBackfill(span, new Set(), 3)).toEqual([200, 199, 198]);
	});

	it('walks backwards past rounds already stored', () => {
		expect(roundsToBackfill(span, new Set([200, 199]), 2)).toEqual([198, 197]);
	});

	it('fills holes left anywhere in the history', () => {
		const stored = new Set(Array.from({ length: 101 }, (_, i) => 100 + i));
		stored.delete(150);
		expect(roundsToBackfill(span, stored, 5)).toEqual([150]);
	});

	it('returns nothing once every round is stored', () => {
		const stored = new Set(Array.from({ length: 101 }, (_, i) => 100 + i));
		expect(roundsToBackfill(span, stored, 10)).toEqual([]);
	});

	it('never returns more than the per-run limit', () => {
		expect(roundsToBackfill(span, new Set(), 10)).toHaveLength(10);
		expect(roundsToBackfill(span, new Set(), 0)).toEqual([]);
	});

	it('does nothing for a tournament with no data', () => {
		expect(roundsToBackfill(null, new Set(), 5)).toEqual([]);
	});
});

describe('fieldFromRows', () => {
	const row = (name: string, corr: number | null, mmc: number | null, stake: number | null): RoundPerfRow => ({
		model_name: name,
		corr,
		mmc,
		tc: null,
		alpha: null,
		mpc: null,
		stake_value: stake
	});

	it('keeps one metric pair per model, in row order', () => {
		const field = fieldFromRows([row('a', 0.01, 0.02, 1), row('b', 0.03, 0.04, 5)], 8);
		expect(field.corr).toEqual([0.01, 0.03]);
		expect(field.mmc).toEqual([0.02, 0.04]);
	});

	it('normalises Signals to its own scored metrics', () => {
		const signalsRow: RoundPerfRow = { ...row('s', 0.01, 0.02, 1), alpha: 0.5, mpc: 0.25 };
		const field = fieldFromRows([signalsRow], 11);
		expect(field).toEqual({ corr: [0.5], mmc: [0.25] });
	});
});

describe('stored fields against a real D1', () => {
	let d1: D1CostHarness;

	beforeAll(async () => {
		d1 = await D1CostHarness.create();
		for (const slice of [CLASSIC, SIGNALS]) await d1.seed(slice);
		await d1.setRoundIndex('round_then_tournament');
	}, 60_000);

	afterAll(async () => d1?.dispose());

	it('stores a round as a single row', async () => {
		const { result: rows } = await d1.measure((db) => selectRoundField(db, 1300, 8));
		const field = fieldFromRows(rows, 8);
		const { cost } = await d1.measure((db) =>
			db.prepare(upsertRoundFieldSql(8, 1300, 'staked', 'alpha_mpc', encodeFieldMetrics(field), 1_700_000_000)).run()
		);
		// The table row plus its primary key index.
		expect(cost.rowsWritten).toBeLessThanOrEqual(2);
	});

	it('reads back one row per round, whatever the field size', async () => {
		for (const round of [1298, 1299]) {
			const { result: rows } = await d1.measure((db) => selectRoundField(db, round, 8));
			await d1.measure((db) =>
				db.prepare(upsertRoundFieldSql(8, round, 'staked', 'alpha_mpc', encodeFieldMetrics(fieldFromRows(rows, 8)), 0)).run()
			);
		}

		const { result, cost } = await d1.measure((db) => readStoredFields(db, 8, 1298, 1300));
		expect([...result.keys()].sort()).toEqual([1298, 1299, 1300]);
		expect(cost.rowsRead).toBeLessThanOrEqual(3 + 1);
	});

	it('reports which rounds are stored, for the backfill to walk', async () => {
		const { result } = await d1.measure((db) => readStoredRounds(bindingQuery(db), 8));
		expect(result.has(1300)).toBe(true);
		expect(result.has(1250)).toBe(false);
	});

	it('keeps the staked and all-models fields side by side for a round', async () => {
		// The chart can rank against the staked field or against everyone who
		// scored, so a round has one stored field per scope.
		const round = 1297;
		for (const scope of ['staked', 'all'] as const) {
			const { result: rows } = await d1.measure((db) => selectRoundField(db, round, 8, scope));
			await d1.measure((db) =>
				db.prepare(upsertRoundFieldSql(8, round, scope, 'alpha_mpc', encodeFieldMetrics(fieldFromRows(rows, 8)), 0)).run()
			);
		}

		const staked = await d1.measure((db) => readStoredFields(db, 8, round, round, 'staked'));
		const all = await d1.measure((db) => readStoredFields(db, 8, round, round, 'all'));

		expect(staked.result.get(round)?.corr).toHaveLength(stakedCount(CLASSIC));
		expect(all.result.get(round)?.corr).toHaveLength(CLASSIC.models);
	});

	it('ranks a model from the stored field exactly as the live rows do', async () => {
		const round = 1300;
		const { result: rows } = await d1.measure((db) => selectRoundField(db, round, 8));

		const live = rows
			.map((r) => ({ name: r.model_name, metrics: pickMetrics(r, 8) }))
			.map((m) => ({
				name: m.name,
				score: FORMULA.corrWeight * (m.metrics.corr ?? 0) + FORMULA.mmcWeight * (m.metrics.mmc ?? 0)
			}))
			.sort((a, b) => b.score - a.score);

		const stored = await d1.measure((db) => readStoredFields(db, 8, round, round));
		const field = stored.result.get(round)!;

		for (const target of [live[0], live[1], live[live.length - 1]]) {
			const own = rows.find((r) => r.model_name === target.name)!;
			expect(rankInField(field, pickMetrics(own, 8), FORMULA)).toEqual({
				rank: live.findIndex((l) => l.name === target.name) + 1,
				totalModels: stakedCount(CLASSIC)
			});
		}
	});

	it('holds only the staked field, matching what the live query selects', async () => {
		const { result: rows } = await d1.measure((db) => selectRoundField(db, 1300, 8));
		const field = fieldFromRows(rows, 8);
		expect(field.corr).toHaveLength(stakedCount(CLASSIC));

		const stored = await d1.measure((db) => readStoredFields(db, 8, 1300, 1300));
		expect(stored.result.get(1300)!.corr).toHaveLength(stakedCount(CLASSIC));
	});

	it('round-trips through storage without changing a rank', async () => {
		const { result: rows } = await d1.measure((db) => selectRoundField(db, 1299, 11));
		const direct = decodeFieldMetrics(encodeFieldMetrics(fieldFromRows(rows, 11)));
		await d1.measure((db) =>
			db.prepare(upsertRoundFieldSql(11, 1299, 'staked', 'alpha_mpc', encodeFieldMetrics(fieldFromRows(rows, 11)), 0)).run()
		);
		const stored = (await d1.measure((db) => readStoredFields(db, 11, 1299, 1299))).result.get(1299)!;

		const own = pickMetrics(rows[0], 11);
		expect(rankInField(stored, own, FORMULA)).toEqual(rankInField(direct, own, FORMULA));
	});
});
