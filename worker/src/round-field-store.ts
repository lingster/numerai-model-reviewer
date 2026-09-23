/**
 * Reading and writing per-round fields in D1, and choosing which rounds the
 * precompute should backfill next.
 *
 * One row per round replaces reading every model's row per round, which is what
 * makes the rankings page affordable on D1's free plan. History is filled in a
 * bounded number of rounds per run, newest first, so the backfill stays inside
 * the daily read budget and covers the default 30-round view immediately.
 */

import { d1Retry } from './d1-retry';
import type { D1Query } from './d1-query';
import { asMetricSet, pickMetrics, type MetricSet } from './ranking';
import type { RoundPerfRow } from './perf-queries';
import { assertTournamentId } from './perf-queries';
import {
	asFieldScope,
	decodeFieldMetrics,
	type DecodedFieldMetrics,
	type EncodedFieldMetrics,
	type FieldMetrics,
	type FieldScope
} from './round-field';
import type { RoundSpan } from './tournament-coverage';

/**
 * Just the metrics a field needs; model identity is deliberately not required.
 * Every metric set's pair is listed, so a caller holding rows in another shape
 * fails to compile rather than storing a field of NaN.
 */
export type FieldRow = Pick<
	RoundPerfRow,
	'corr' | 'mmc' | 'tc' | 'alpha' | 'mpc' | 'neutral_corr' | 'neutral_mmc' | 'corr60' | 'mmc60'
>;

/**
 * A round's field from its rows, normalised for the tournament (Signals is
 * scored on alpha/mpc). Rows must already be the staked field — the same set
 * the live ranking path selects — since that is who a model is ranked against.
 */
export function fieldFromRows(
	rows: ReadonlyArray<FieldRow>,
	tournament: number,
	metricSet: MetricSet = 'alpha_mpc'
): FieldMetrics {
	const corr: Array<number | null> = [];
	const mmc: Array<number | null> = [];
	for (const row of rows) {
		const metrics = pickMetrics(row as RoundPerfRow, tournament, metricSet);
		corr.push(metrics.corr);
		mmc.push(metrics.mmc);
	}
	return { corr, mmc };
}

/** Store (or replace) one round's field. */
export function upsertRoundFieldSql(
	tournament: number,
	round: number,
	scope: FieldScope,
	metricSet: MetricSet,
	encoded: EncodedFieldMetrics,
	nowSeconds: number
): string {
	assertTournamentId(tournament);
	if (!Number.isSafeInteger(round)) {
		throw new RangeError(`round must be an integer, got ${round}`);
	}
	return `INSERT OR REPLACE INTO round_field_metrics (tournament, round_number, field_scope, metric_set, corr_values, mmc_values, updated_at)
	        VALUES (${tournament}, ${round}, '${asFieldScope(scope)}', '${asMetricSet(metricSet)}', '${encoded.corr}', '${encoded.mmc}', ${Math.floor(nowSeconds)})`;
}

/** Every round that already has a stored field, so the backfill can skip them. */
export async function readStoredRounds(
	query: D1Query,
	tournament: number,
	scope: FieldScope = 'staked',
	metricSet: MetricSet = 'alpha_mpc'
): Promise<Set<number>> {
	assertTournamentId(tournament);
	const rows = await query(
		`SELECT round_number FROM round_field_metrics
		  WHERE tournament = ${tournament} AND field_scope = '${asFieldScope(scope)}'
		    AND metric_set = '${asMetricSet(metricSet)}'`
	);
	const rounds = new Set<number>();
	for (const row of rows) {
		if (typeof row.round_number === 'number') rounds.add(row.round_number);
	}
	return rounds;
}

/** Stored fields for [fromRound, toRound], keyed by round. Rounds not yet stored are absent. */
export async function readStoredFields(
	db: D1Database,
	tournament: number,
	fromRound: number,
	toRound: number,
	scope: FieldScope = 'staked',
	metricSet: MetricSet = 'alpha_mpc'
): Promise<Map<number, DecodedFieldMetrics>> {
	const result = await d1Retry(() =>
		db
			.prepare(
				`SELECT round_number, corr_values, mmc_values
				   FROM round_field_metrics
				  WHERE tournament = ? AND round_number BETWEEN ? AND ? AND field_scope = ?
				    AND metric_set = ?`
			)
			.bind(tournament, fromRound, toRound, asFieldScope(scope), asMetricSet(metricSet))
			.all<{ round_number: number; corr_values: string; mmc_values: string }>()
	);

	const fields = new Map<number, DecodedFieldMetrics>();
	for (const row of result.results ?? []) {
		fields.set(row.round_number, decodeFieldMetrics({ corr: row.corr_values, mmc: row.mmc_values }));
	}
	return fields;
}

/**
 * The next rounds to build fields for: up to `limit` rounds inside the
 * tournament's stored span that have no field yet, newest first.
 *
 * Newest first because the rankings page opens on the most recent rounds, so
 * the view people actually load is covered by the first run rather than the
 * last.
 */
export function roundsToBackfill(
	span: RoundSpan | null,
	stored: ReadonlySet<number>,
	limit: number
): number[] {
	if (!span || limit <= 0) return [];

	const rounds: number[] = [];
	for (let round = span.latestRound; round >= span.earliestRound && rounds.length < limit; round--) {
		if (!stored.has(round)) rounds.push(round);
	}
	return rounds;
}
