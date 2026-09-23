/**
 * Precompute's write phase against a real SQLite file: what the scheduler runs
 * nightly, minus the Numerai fetch. Steps 5–7 must fill every table the API
 * reads, and an overlapping run must rewrite rounds that are still resolving.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistRun, type PerformanceRound, type TopModel } from '../../worker/src/precompute.js';
import { openDatabase } from './database.js';
import { createSqliteTarget, sqliteWriter } from './sqlite-target.js';
import { readStoredFields } from '../../worker/src/round-field-store.js';
import type { SqliteD1 } from './sqlite-d1.js';
import { testConfig } from './test-support/server-config.js';

const CRYPTO = 12;
const SIGNALS = 11;

let directory: string;
let db: SqliteD1;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-precompute-'));
	db = openDatabase(testConfig(join(directory, 'test.sqlite')));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

const round = (roundNumber: number, corr: number): PerformanceRound => ({
	roundNumber,
	corr,
	mmc: corr / 2,
	tc: null,
	alpha: null,
	mpc: null,
	stakeValue: 10
});

const models: TopModel[] = [
	{ modelId: 'id-a', modelName: 'model_a', username: 'alice', stakeValue: 10 },
	{ modelId: 'id-b', modelName: 'model_b', username: 'bob', stakeValue: 20 }
];

const run = (performanceData: Map<string, PerformanceRound[]>, minRound = 0) =>
	persistRun(createSqliteTarget(db, 'test.sqlite'), {
		allModels: models,
		performanceData,
		tournament: CRYPTO,
		reset: false,
		minRound,
		backfillRounds: 100
	});

const count = (table: string): number =>
	db.selectSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tournament = ?`, CRYPTO)[0].n;

describe('precompute into SQLite', () => {
	it('writes performances, models, coverage and round fields', async () => {
		const result = await run(
			new Map([
				['model_a', [round(100, 0.01), round(101, 0.02), round(102, 0.03)]],
				['model_b', [round(100, -0.01), round(101, 0.0), round(102, 0.04)]]
			])
		);

		expect(count('model_performances')).toBe(6);
		expect(count('top_staked_models')).toBe(2);
		expect(result.coverage).toEqual({ earliestRound: 100, latestRound: 102 });
		expect(
			db.selectSync('SELECT earliest_round, latest_round FROM tournament_coverage WHERE tournament = ?', CRYPTO)
		).toEqual([{ earliest_round: 100, latest_round: 102 }]);
		expect(result.fresh).toBe(3);
		// One field per round per scope: the staked field, and every model that scored.
		expect(count('round_field_metrics')).toBe(6);
		expect(
			db.selectSync<{ field_scope: string; n: number }>(
				'SELECT field_scope, COUNT(*) AS n FROM round_field_metrics WHERE tournament = ? GROUP BY field_scope ORDER BY field_scope',
				CRYPTO
			)
		).toEqual([
			{ field_scope: 'all', n: 3 },
			{ field_scope: 'staked', n: 3 }
		]);
	});

	it('rewrites rounds inside the refresh overlap with their latest scores', async () => {
		await run(new Map([['model_a', [round(100, 0.01), round(101, 0.02)]]]));
		await run(new Map([['model_a', [round(100, 0.99), round(101, 0.05), round(102, 0.06)]]]), 101);

		const corr = db.selectSync<{ round_number: number; corr: number }>(
			'SELECT round_number, corr FROM model_performances WHERE tournament = ? ORDER BY round_number',
			CRYPTO
		);
		// Below the floor stays as first stored; the overlap and the new round are rewritten.
		expect(corr).toEqual([
			{ round_number: 100, corr: 0.01 },
			{ round_number: 101, corr: 0.05 },
			{ round_number: 102, corr: 0.06 }
		]);
	});
});

describe('Signals metric sets', () => {
	it('stores a usable neutral field, not an empty one', async () => {
		// precompute's rounds name the pair neutralCorr/neutralMmc; the stored field
		// reads neutral_corr/neutral_mmc. A cast between the two silently produced
		// fields of NaN, and every model then ranked "1 of 1".
		const signalsRound = (roundNumber: number, corr: number): PerformanceRound => ({
			roundNumber,
			corr: null,
			mmc: null,
			tc: null,
			alpha: corr,
			mpc: corr,
			neutralCorr: corr * 2,
			neutralMmc: corr * 3,
			stakeValue: 5
		});

		await persistRun(createSqliteTarget(db, 'test.sqlite'), {
			allModels: models,
			performanceData: new Map([
				['model_a', [signalsRound(200, 0.01)]],
				['model_b', [signalsRound(200, 0.02)]]
			]),
			tournament: SIGNALS,
			reset: false,
			minRound: 0,
			backfillRounds: 100
		});

		const fields = await readStoredFields(db.asD1(), SIGNALS, 200, 200, 'staked', 'neutral');
		const neutral = fields.get(200);
		expect(neutral?.corr).toHaveLength(2);
		// The neutral pair, not NaN and not alpha/mpc.
		expect([...(neutral?.corr ?? [])].sort()).toEqual([0.02, 0.04]);
		expect([...(neutral?.mmc ?? [])].sort()).toEqual([0.03, 0.06]);
	});
});

describe('sqliteWriter', () => {
	it('rolls the whole batch back when a statement fails', async () => {
		const write = sqliteWriter(db);
		const insert = `INSERT INTO top_staked_models (model_id, model_name, username, stake_value, tournament, updated_at)
			VALUES ('x', 'x', 'x', 1, ${CRYPTO}, 0)`;

		await expect(write([insert, 'INSERT INTO no_such_table VALUES (1)'], 'test batch')).rejects.toThrow(
			/SQLite test batch failed/
		);
		expect(count('top_staked_models')).toBe(0);
	});
});
