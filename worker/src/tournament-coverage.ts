/**
 * The round span each tournament's stored performance data covers, kept in one
 * tournament_coverage row per tournament so a page load reads a single row.
 *
 * Why a table: /rankings/cache-status runs on every rankings page load, and
 * computing MIN/MAX(round_number) per tournament on production's index read a
 * large share of the ~5M-row table each time — a few Signals or Crypto page
 * views were a whole day of D1's free read quota. The index swap that makes it
 * cheap (migrations/0001) writes ~5M rows itself, so it can't run on the free
 * plan either.
 *
 * Precompute owns the row: after every store it recomputes the span from the
 * table and replaces it, which stays exact through incremental runs, backfills
 * and resets alike. The worker only reads it, computing the span on the fly
 * when there is no row yet.
 */

import type { D1Query } from './d1-query';
import { assertTournamentId } from './perf-queries';

/** The first and last round stored for a tournament. */
export interface RoundSpan {
	earliestRound: number;
	latestRound: number;
}

/** model_performances has no round index, so any span query would scan the table. */
export class NoRoundIndexError extends Error {
	constructor() {
		super(
			'model_performances has no round index (idx_perf_tournament_round or idx_perf_round); ' +
				'refusing to compute the round span with a full table scan'
		);
		this.name = 'NoRoundIndexError';
	}
}

/** A way to find a tournament's span that is cheap given one particular index. */
interface SpanStrategy {
	index: string;
	sql(tournament: number): string;
}

/** Row exists for this tournament in round `n` — one seek on (round_number, tournament). */
const hasTournamentRound = (tournament: number, n: string): string =>
	`EXISTS (SELECT 1 FROM model_performances WHERE round_number = ${n} AND tournament = ${tournament})`;

/**
 * Preferred order. Each strategy is only safe with its own index: the round walk
 * on the (tournament, round_number) index would scan the table once per step.
 */
const STRATEGIES: readonly SpanStrategy[] = [
	{
		// After migrations/0001: a direct seek to each end of the tournament's rounds.
		// MIN and MAX stay separate subqueries — together they scan every match.
		index: 'idx_perf_tournament_round',
		sql: (t) =>
			`SELECT (SELECT MIN(round_number) FROM model_performances WHERE tournament = ${t}) AS earliestRound,
			        (SELECT MAX(round_number) FROM model_performances WHERE tournament = ${t}) AS latestRound`
	},
	{
		// Production today, (round_number, tournament): step through distinct rounds
		// from each end with index seeks, stopping at the first round that has this
		// tournament. Costs a few reads per distinct round walked (~1.1k rounds at
		// most), never a read per row (~5k rows per round).
		index: 'idx_perf_round',
		sql: (t) =>
			`WITH RECURSIVE
			   up(n) AS (
			     SELECT MIN(round_number) FROM model_performances
			     UNION ALL
			     SELECT (SELECT MIN(round_number) FROM model_performances WHERE round_number > up.n)
			       FROM up WHERE up.n IS NOT NULL AND NOT ${hasTournamentRound(t, 'up.n')}
			   ),
			   down(n) AS (
			     SELECT MAX(round_number) FROM model_performances
			     UNION ALL
			     SELECT (SELECT MAX(round_number) FROM model_performances WHERE round_number < down.n)
			       FROM down WHERE down.n IS NOT NULL AND NOT ${hasTournamentRound(t, 'down.n')}
			   )
			 SELECT
			   (SELECT n FROM (SELECT MAX(n) AS n FROM up) WHERE ${hasTournamentRound(t, 'n')}) AS earliestRound,
			   (SELECT n FROM (SELECT MIN(n) AS n FROM down) WHERE ${hasTournamentRound(t, 'n')}) AS latestRound`
	}
];

const STRATEGY_INDEXES = STRATEGIES.map((s) => `'${s.index}'`).join(', ');

/** A span from a row holding earliestRound/latestRound, or null when either is missing. */
function toSpan(row: Record<string, unknown> | undefined): RoundSpan | null {
	const earliestRound = row?.earliestRound;
	const latestRound = row?.latestRound;
	return typeof earliestRound === 'number' && typeof latestRound === 'number'
		? { earliestRound, latestRound }
		: null;
}

/**
 * The span of rounds stored for `tournament`, computed from model_performances
 * with whichever cheap strategy its indexes allow. Null when it has no rows.
 * @throws NoRoundIndexError when neither round index exists.
 */
export async function computeRoundSpan(query: D1Query, tournament: number): Promise<RoundSpan | null> {
	assertTournamentId(tournament);

	const indexes = new Set(
		(
			await query(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'model_performances' AND name IN (${STRATEGY_INDEXES})`
			)
		).map((row) => row.name)
	);
	const strategy = STRATEGIES.find((s) => indexes.has(s.index));
	if (!strategy) throw new NoRoundIndexError();

	const [row] = await query(strategy.sql(tournament));
	return toSpan(row);
}

/** The span stored in tournament_coverage, or null when there is no row. */
export async function readStoredCoverage(query: D1Query, tournament: number): Promise<RoundSpan | null> {
	assertTournamentId(tournament);
	const [row] = await query(
		`SELECT earliest_round AS earliestRound, latest_round AS latestRound
		   FROM tournament_coverage WHERE tournament = ${tournament}`
	);
	return toSpan(row);
}

/**
 * The span for a page load: the stored row, or — before precompute has written
 * one — the span computed on the fly. Never writes.
 */
export async function getRoundCoverage(query: D1Query, tournament: number): Promise<RoundSpan | null> {
	let stored: RoundSpan | null = null;
	try {
		stored = await readStoredCoverage(query, tournament);
	} catch (error) {
		// Falling back is safe here: computing the span is a bounded read, not a
		// write, so a missing table (schema not yet applied) costs little.
		console.error('tournament_coverage read failed; computing the span instead:', error);
	}
	return stored ?? computeRoundSpan(query, tournament);
}

/**
 * Recompute `tournament`'s span from model_performances and store it, or clear
 * the row when the tournament has no data. Run by precompute after each store.
 */
export async function refreshCoverage(
	query: D1Query,
	tournament: number,
	nowSeconds = Math.floor(Date.now() / 1000)
): Promise<RoundSpan | null> {
	const span = await computeRoundSpan(query, tournament);

	await query(
		span
			? `INSERT OR REPLACE INTO tournament_coverage (tournament, earliest_round, latest_round, updated_at)
			   VALUES (${tournament}, ${span.earliestRound}, ${span.latestRound}, ${Math.floor(nowSeconds)})`
			: `DELETE FROM tournament_coverage WHERE tournament = ${tournament}`
	);
	return span;
}
