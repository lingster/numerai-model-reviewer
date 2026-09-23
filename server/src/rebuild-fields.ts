/**
 * Rebuild the stored per-round fields from model_performances.
 *
 *   tsx src/rebuild-fields.ts [--tournament 8,11,12] [--scope staked,all] [--metric-set alpha_mpc,neutral]
 *
 * Precompute writes these as it fetches, and only for rounds that have no field
 * yet — so a field that was stored wrongly, or a newly added scope or metric set
 * over history, needs this. It reads only the local database: no Numerai calls,
 * no refetch of a day's worth of scores to correct a derived table.
 */

import { CRYPTO_TOURNAMENT, SIGNALS_TOURNAMENT } from '../../worker/src/mappers.js';
import { selectRoundField } from '../../worker/src/perf-queries.js';
import { encodeFieldMetrics, FIELD_SCOPES, type FieldScope } from '../../worker/src/round-field.js';
import { fieldFromRows, upsertRoundFieldSql } from '../../worker/src/round-field-store.js';
import { metricSetsFor, type MetricSet } from '../../worker/src/ranking.js';
import { computeRoundSpan } from '../../worker/src/tournament-coverage.js';
import { bindingQuery } from '../../worker/src/d1-query.js';
import type { SqliteD1 } from './sqlite-d1.js';

const TOURNAMENTS = [8, SIGNALS_TOURNAMENT, CRYPTO_TOURNAMENT];

export interface RebuildOptions {
	tournaments?: readonly number[];
	scopes?: readonly FieldScope[];
	metricSets?: readonly MetricSet[];
	/** Called after each round, for progress output. */
	onRound?: (tournament: number, round: number, written: number, total: number) => void;
}

/** Rebuild every (round, scope, metric set) field for the given tournaments. */
export async function rebuildStoredFields(
	db: SqliteD1,
	options: RebuildOptions = {}
): Promise<Map<number, number>> {
	const query = bindingQuery(db.asD1());
	const written = new Map<number, number>();

	for (const tournament of options.tournaments ?? TOURNAMENTS) {
		const span = await computeRoundSpan(query, tournament);
		if (!span) continue;

		const scopes = options.scopes ?? FIELD_SCOPES;
		const metricSets = (options.metricSets ?? metricSetsFor(tournament)).filter((set) =>
			metricSetsFor(tournament).includes(set)
		);
		const now = Math.floor(Date.now() / 1000);
		const total = span.latestRound - span.earliestRound + 1;
		let count = 0;

		for (let round = span.earliestRound; round <= span.latestRound; round++) {
			for (const scope of scopes) {
				const rows = await selectRoundField(db.asD1(), round, tournament, scope);
				if (rows.length === 0) continue;
				for (const metricSet of metricSets) {
					const field = fieldFromRows(rows, tournament, metricSet);
					db.execSync(upsertRoundFieldSql(tournament, round, scope, metricSet, encodeFieldMetrics(field), now));
					count++;
				}
			}
			options.onRound?.(tournament, round, count, total);
		}
		written.set(tournament, count);
	}
	return written;
}

const list = (flag: string): string[] | undefined => {
	const index = process.argv.indexOf(flag);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1].split(',') : undefined;
};

const invokedDirectly = /rebuild-fields\.[cm]?ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
	const { loadConfig } = await import('./config.js');
	const { openDatabase } = await import('./database.js');
	const config = loadConfig();
	const db = openDatabase(config);
	const started = Date.now();
	try {
		const written = await rebuildStoredFields(db, {
			tournaments: list('--tournament')?.map(Number),
			scopes: list('--scope') as FieldScope[] | undefined,
			metricSets: list('--metric-set') as MetricSet[] | undefined,
			onRound: (tournament, round, count, total) => {
				if (round % 100 === 0) console.log(`  t${tournament} round ${round}: ${count} field(s) of ~${total} rounds`);
			}
		});
		for (const [tournament, count] of written) console.log(`tournament ${tournament}: ${count} fields written`);
		console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	} finally {
		db.close();
	}
}
