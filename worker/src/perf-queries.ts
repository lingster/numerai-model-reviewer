/**
 * SQL for the precomputed rankings tables, in one place.
 *
 * Every statement here runs against tables holding millions of rows on a D1
 * plan that bills — and hard-caps — rows read and rows written per day. Keeping
 * them together means the query-cost tests (d1-query-cost.test.ts) measure the
 * exact SQL production runs, rather than a copy that can drift.
 */

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
