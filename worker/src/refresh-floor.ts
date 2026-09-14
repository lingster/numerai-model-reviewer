/**
 * The incremental-refresh high-water mark: the highest round already stored in
 * D1 for a tournament.
 *
 * Precompute uses it to decide between an incremental run (fetch and write only
 * newer rounds — ~9k rows a day) and a full backfill (every round of every
 * model — ~1.4M rows). That asymmetry is why a failed read must never look like
 * an empty table: it used to, and when D1's daily read quota ran out mid-job the
 * "fallback" rewrote the whole history three times in ten days.
 *
 * So this resolves `null` only for a read that succeeded and found no rows, and
 * throws for anything else. Precompute lets the error end the run.
 */

import type { D1Query } from './d1-query';
import { maxRoundSql } from './perf-queries';

/** The max-round read failed, or returned something that is not a round. */
export class MaxRoundReadError extends Error {
	constructor(tournament: number, detail: string, options?: { cause?: unknown }) {
		super(`Could not read the latest stored round for tournament ${tournament}: ${detail}`, options);
		this.name = 'MaxRoundReadError';
	}
}

const describe = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Highest stored round for `tournament`, or null when it has no rows yet.
 * @throws MaxRoundReadError when the read fails or its result is unrecognisable.
 */
export async function readMaxRound(read: D1Query, tournament: number): Promise<number | null> {
	const sql = maxRoundSql(tournament);

	let rows: ReadonlyArray<Record<string, unknown>>;
	try {
		rows = await read(sql);
	} catch (error) {
		throw new MaxRoundReadError(tournament, describe(error), { cause: error });
	}

	// MAX() always yields exactly one row; no row, or no maxRound column, means
	// the result is not what we asked for — not that the table is empty.
	const row = rows[0];
	if (!row || !('maxRound' in row)) {
		throw new MaxRoundReadError(tournament, `unexpected result ${JSON.stringify(rows)}`);
	}

	const { maxRound } = row;
	if (maxRound === null) return null;
	if (typeof maxRound === 'number' && Number.isSafeInteger(maxRound)) return maxRound;

	throw new MaxRoundReadError(tournament, `maxRound is not a round number: ${JSON.stringify(maxRound)}`);
}
