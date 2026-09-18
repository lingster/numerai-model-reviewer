/**
 * One SQL statement in, result rows out — the seam between query logic and how
 * D1 is reached.
 *
 * Precompute reaches D1 through the wrangler CLI (no parameter binding); the
 * worker has a D1 binding. Code written against D1Query runs unchanged on both,
 * and in tests against Miniflare.
 */

import { d1Retry } from './d1-retry';

/** Runs one SQL statement and resolves with its result rows ([] for writes). */
export type D1Query = (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** A D1Query over a worker D1 binding, with the usual transient-error retry. */
export function bindingQuery(db: D1Database): D1Query {
	return async (sql) => {
		const result = await d1Retry(() => db.prepare(sql).all<Record<string, unknown>>());
		return result.results ?? [];
	};
}
