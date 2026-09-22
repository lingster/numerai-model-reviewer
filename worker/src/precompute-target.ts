/**
 * Where precompute stores what it fetched — the seam between the pipeline and
 * the database it writes.
 *
 * The pipeline reads through `query` and writes through `write`, so the same
 * code fills remote D1 via the wrangler CLI (GitHub Actions) and a local SQLite
 * file (the self-hosted server's scheduler) without knowing which.
 */

import type { D1Query } from './d1-query';

/**
 * Runs a batch of SQL statements for their effect, all or nothing. `label`
 * names the batch in logs and errors.
 */
export type SqlWriter = (statements: ReadonlyArray<string>, label: string) => Promise<void>;

export interface PrecomputeTarget {
	/** For logs, e.g. "remote D1" or "SQLite /data/numerai-cache.sqlite". */
	description: string;
	query: D1Query;
	write: SqlWriter;
}
