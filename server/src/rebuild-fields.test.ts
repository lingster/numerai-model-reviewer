/**
 * Rebuilding stored fields from model_performances, with no Numerai calls.
 *
 * Precompute only writes a field for a round that has none, so a field stored
 * wrongly — or a scope or metric set added after the history was built — can
 * only be corrected here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredFields } from '../../worker/src/round-field-store.js';
import { openDatabase } from './database.js';
import { rebuildStoredFields, metricSetsFor } from './rebuild-fields.js';
import type { SqliteD1 } from './sqlite-d1.js';
import { testConfig } from './test-support/server-config.js';

const SIGNALS = 11;
const CLASSIC = 8;

let directory: string;
let db: SqliteD1;

/** One Signals row: alpha/mpc and the neutral pair differ, so a swap is visible. */
const insert = (model: string, round: number, alpha: number, staked = true) =>
	db.execSync(
		`INSERT OR REPLACE INTO model_performances
		   (model_name, round_number, corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc, stake_value, tournament, updated_at)
		 VALUES ('${model}', ${round}, NULL, NULL, NULL, ${alpha}, ${alpha}, ${alpha * 2}, ${alpha * 3}, ${staked ? 1 : 0}, ${SIGNALS}, 0)`
	);

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-rebuild-'));
	db = openDatabase(testConfig(join(directory, 'test.sqlite')));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe('rebuildStoredFields', () => {
	it('writes every scope and metric set a tournament has, from the stored rows', async () => {
		insert('staked_a', 300, 0.01);
		insert('staked_b', 300, 0.02);
		insert('unstaked_c', 300, 0.03, false);

		const written = await rebuildStoredFields(db, { tournaments: [SIGNALS] });

		// 1 round x 2 scopes x 2 metric sets.
		expect(written.get(SIGNALS)).toBe(4);
		const staked = await readStoredFields(db.asD1(), SIGNALS, 300, 300, 'staked', 'alpha_mpc');
		const all = await readStoredFields(db.asD1(), SIGNALS, 300, 300, 'all', 'neutral');
		expect([...staked.get(300)!.corr].sort()).toEqual([0.01, 0.02]);
		expect([...all.get(300)!.corr].sort()).toEqual([0.02, 0.04, 0.06]);
	});

	it('overwrites a field that was stored wrongly', async () => {
		insert('staked_a', 300, 0.01);
		await rebuildStoredFields(db, { tournaments: [SIGNALS] });
		db.execSync(`UPDATE round_field_metrics SET corr_values = 'AAAAAAAAAAA=' WHERE metric_set = 'neutral'`);

		await rebuildStoredFields(db, { tournaments: [SIGNALS], metricSets: ['neutral'] });

		const fields = await readStoredFields(db.asD1(), SIGNALS, 300, 300, 'staked', 'neutral');
		expect([...fields.get(300)!.corr]).toEqual([0.02]);
	});

	it('gives tournaments without a second metric pair only alpha_mpc', () => {
		expect(metricSetsFor(CLASSIC)).toEqual(['alpha_mpc']);
		expect(metricSetsFor(SIGNALS)).toEqual(['alpha_mpc', 'neutral']);
	});
});
