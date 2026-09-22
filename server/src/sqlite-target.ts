/**
 * Precompute's target over the server's SQLite file: the worker's pipeline,
 * unchanged, writing here instead of to D1 through wrangler.
 */

import { bindingQuery } from '../../worker/src/d1-query.js';
import type { PrecomputeTarget, SqlWriter } from '../../worker/src/precompute-target.js';
import type { SqliteD1 } from './sqlite-d1.js';

/** Each batch is one transaction: a failing statement rolls the whole batch back. */
export function sqliteWriter(db: SqliteD1): SqlWriter {
	return async (statements, label) => {
		db.execSync('BEGIN');
		try {
			for (const statement of statements) db.execSync(statement);
			db.execSync('COMMIT');
		} catch (error) {
			db.execSync('ROLLBACK');
			throw new Error(`SQLite ${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error
			});
		}
	};
}

export function createSqliteTarget(db: SqliteD1, databasePath: string): PrecomputeTarget {
	return {
		description: `SQLite ${databasePath}`,
		query: bindingQuery(db.asD1()),
		write: sqliteWriter(db)
	};
}
