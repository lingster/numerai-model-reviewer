/**
 * SQL for the precomputed rankings tables, in one place.
 *
 * Every statement here runs against tables holding millions of rows on a D1
 * plan that bills — and hard-caps — rows read and rows written per day. Keeping
 * them together means the query-cost tests (d1-query-cost.test.ts) measure the
 * exact SQL production runs, rather than a copy that can drift.
 */

import { d1Retry } from './d1-retry';
import { CRYPTO_TOURNAMENT } from './mappers';
import type { FieldScope } from './round-field';

/** A model's identity as stored in top_staked_models. */
export interface TopModelRow {
	model_id: string;
	model_name: string;
	username: string;
}

/** One model's stored scores for a round. */
export interface RoundPerfRow {
	model_name: string;
	corr: number | null;
	mmc: number | null;
	tc: number | null;
	alpha: number | null;
	mpc: number | null;
	/** Signals' neutral pair; null for Classic and Crypto, and for rows stored before migration 0005. */
	neutral_corr?: number | null;
	neutral_mmc?: number | null;
	stake_value: number | null;
}

/**
 * Guard for the few statements that inline the tournament id rather than bind
 * it (the wrangler CLI's --command has no parameter binding).
 */
export function assertTournamentId(tournament: number): void {
	if (!Number.isSafeInteger(tournament) || tournament <= 0) {
		throw new RangeError(`tournament must be a positive integer, got ${tournament}`);
	}
}

/**
 * Highest stored round for a tournament. MAX over no rows yields one row whose
 * `maxRound` is NULL, which callers treat as "no data yet".
 */
export function maxRoundSql(tournament: number): string {
	assertTournamentId(tournament);
	return `SELECT MAX(round_number) AS maxRound FROM model_performances WHERE tournament = ${tournament}`;
}

/**
 * The "staked field" filter. Crypto rows carry no stake data, so every Crypto
 * row counts; Classic and Signals count only rows with a positive stake.
 */
/** The rows a field of this scope contains: only staked ones, or all of them. */
const scopeFilter = (tournament: number, scope: FieldScope): string =>
	scope === 'all' ? '' : stakedFilter(tournament);

const stakedFilter = (tournament: number): string =>
	tournament === CRYPTO_TOURNAMENT ? '' : ' AND stake_value IS NOT NULL AND stake_value > 0';

/** The same condition as {@link stakedFilter}, in TypeScript. */
export const isStakedRow = (row: { stake_value: number | null }): boolean =>
	row.stake_value !== null && row.stake_value > 0;

/**
 * Whether a row belongs to the round's staked field — what selectRoundField
 * returns, and so what a rank is measured against.
 */
export const inStakedField = (row: { stake_value: number | null }, tournament: number): boolean =>
	tournament === CRYPTO_TOURNAMENT || isStakedRow(row);

/**
 * Was the model staked in this round? Null for Crypto, whose rows carry the
 * model's current stake rather than the round's, so the answer is unknown.
 */
export const wasStaked = (row: { stake_value: number | null }, tournament: number): boolean | null =>
	tournament === CRYPTO_TOURNAMENT ? null : isStakedRow(row);

// neutral_corr/neutral_mmc are Signals' new payout pair (see ranking.ts
// MetricSet). Listed here so both pairs travel together and migration 0005's
// index still covers every column a field read needs.
const ROUND_PERF_COLUMNS =
	'model_name, corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc, stake_value';

/**
 * Look up a model's id and owner, case-insensitively by name.
 *
 * Lowercases the *input* only. Numerai model names are always lowercase (none
 * of 17,381 across Classic, Signals and Crypto has an uppercase letter), so this
 * matches exactly what LOWER(model_name) = LOWER(?) did — but seeks the primary
 * key for one row instead of scanning every staked model, since wrapping the
 * column in LOWER() made it unindexable.
 */
export async function selectTopModelByName(
	db: D1Database,
	modelName: string,
	tournament: number
): Promise<TopModelRow | null> {
	const row = await d1Retry(() =>
		db
			.prepare(
				`SELECT model_id, model_name, username
				   FROM top_staked_models
				  WHERE model_name = LOWER(?) AND tournament = ?`
			)
			.bind(modelName, tournament)
			.first<TopModelRow>()
	);
	return row ?? null;
}

/** Every model's scores for one round, within the given field scope. */
export async function selectRoundField(
	db: D1Database,
	round: number,
	tournament: number,
	scope: FieldScope = 'staked'
): Promise<RoundPerfRow[]> {
	const result = await d1Retry(() =>
		db
			.prepare(
				`SELECT ${ROUND_PERF_COLUMNS}
				   FROM model_performances
				  WHERE round_number = ? AND tournament = ?${scopeFilter(tournament, scope)}`
			)
			.bind(round, tournament)
			.all<RoundPerfRow>()
	);
	return result.results ?? [];
}

/**
 * One model's own scores for each round in [fromRound, toRound], restricted to
 * the rounds where it was part of the staked field — the same filter the field
 * itself is built with, so a round it sat out has no row here and the caller
 * knows to rank it another way.
 *
 * The primary key leads with model_name, so this seeks rather than scanning:
 * reads are about the number of rounds returned, not the size of the field.
 *
 * `+tournament` keeps it that way. Without table statistics the planner rates
 * a (tournament, round_number) index — tournament equality plus a round range —
 * above the primary key's model_name equality plus a round range, and range-
 * scans every model's rows in the round range instead of one row per round —
 * ~5k times the reads at production scale, ~2s on the self-hosted server for a
 * 166-round view. The unary plus makes the tournament term unusable by an
 * index without changing what it matches (the tournament is always bound as a
 * number, so affinity does not come into it).
 */
export async function selectModelRounds(
	db: D1Database,
	modelName: string,
	tournament: number,
	fromRound: number,
	toRound: number,
	{ includeUnstaked = false }: { includeUnstaked?: boolean } = {}
): Promise<Array<RoundPerfRow & { round_number: number }>> {
	const result = await d1Retry(() =>
		db
			.prepare(
				`SELECT round_number, ${ROUND_PERF_COLUMNS}
				   FROM model_performances
				  WHERE model_name = LOWER(?) AND +tournament = ? AND round_number BETWEEN ? AND ?${
					includeUnstaked ? '' : stakedFilter(tournament)
				}`
			)
			.bind(modelName, tournament, fromRound, toRound)
			.all<RoundPerfRow & { round_number: number }>()
	);
	return result.results ?? [];
}

/** Every model's scores for each round in [fromRound, toRound], within the scope. */
export async function selectRoundFieldsInRange(
	db: D1Database,
	fromRound: number,
	toRound: number,
	tournament: number,
	scope: FieldScope = 'staked'
): Promise<Array<RoundPerfRow & { round_number: number }>> {
	const result = await d1Retry(() =>
		db
			.prepare(
				`SELECT round_number, ${ROUND_PERF_COLUMNS}
				   FROM model_performances
				  WHERE round_number BETWEEN ? AND ? AND tournament = ?${scopeFilter(tournament, scope)}`
			)
			.bind(fromRound, toRound, tournament)
			.all<RoundPerfRow & { round_number: number }>()
	);
	return result.results ?? [];
}
