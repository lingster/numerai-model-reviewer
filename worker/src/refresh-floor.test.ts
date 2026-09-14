/**
 * Unit tests for reading the incremental-refresh high-water mark.
 *
 * Regression: precompute used to treat *any* failure to read MAX(round_number)
 * as "the tournament has no rows" and fall back to a full backfill. When D1's
 * daily read quota ran out mid-job, that turned a ~9k-row incremental run into a
 * ~1.4M-row rewrite (2026-09-04, -06 and -13). A failed read must now stop the
 * run; only a read that succeeds and finds no rows may start a backfill.
 */
import { describe, it, expect } from 'vitest';
import type { D1Query } from './d1-query';
import { readMaxRound, MaxRoundReadError } from './refresh-floor';

/** A reader that answers every query with the given rows. */
const answering = (rows: ReadonlyArray<Record<string, unknown>>): D1Query => async () => rows;

/** A reader whose query fails, like wrangler hitting the read quota. */
const failing = (message: string): D1Query => async () => {
	throw new Error(message);
};

describe('readMaxRound', () => {
	it('returns the highest stored round when the tournament has rows', async () => {
		await expect(readMaxRound(answering([{ maxRound: 1348 }]), 11)).resolves.toBe(1348);
	});

	it('returns null only when the read succeeds and the tournament has no rows', async () => {
		// MAX() over zero rows is a single row holding NULL.
		await expect(readMaxRound(answering([{ maxRound: null }]), 12)).resolves.toBeNull();
	});

	it('throws instead of returning null when the read fails', async () => {
		const quota = "Your account has exceeded D1's free tier daily row read limit";
		await expect(readMaxRound(failing(quota), 11)).rejects.toBeInstanceOf(MaxRoundReadError);
	});

	it('keeps the underlying cause in the error so the log explains the failure', async () => {
		const quota = "Your account has exceeded D1's free tier daily row read limit";
		await expect(readMaxRound(failing(quota), 11)).rejects.toThrow(quota);
	});

	it('throws when the result has no row at all, rather than assuming an empty table', async () => {
		await expect(readMaxRound(answering([]), 8)).rejects.toBeInstanceOf(MaxRoundReadError);
	});

	it('throws when maxRound is neither a number nor null', async () => {
		await expect(readMaxRound(answering([{ maxRound: '1348' }]), 8)).rejects.toBeInstanceOf(
			MaxRoundReadError
		);
		await expect(readMaxRound(answering([{ unexpected: 1 }]), 8)).rejects.toBeInstanceOf(
			MaxRoundReadError
		);
	});

	it('asks for the requested tournament only', async () => {
		let seen = '';
		const spy: D1Query = async (sql) => {
			seen = sql;
			return [{ maxRound: 1 }];
		};
		await readMaxRound(spy, 12);
		expect(seen).toMatch(/WHERE\s+tournament\s*=\s*12\b/);
	});

	it('rejects a non-integer tournament rather than interpolating it into SQL', async () => {
		await expect(readMaxRound(answering([{ maxRound: 1 }]), 8.5)).rejects.toThrow(/tournament/);
	});
});
