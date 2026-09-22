/**
 * A D1Database over a local SQLite file.
 *
 * D1 *is* SQLite, so the worker's queries need no translation — only the
 * binding's shape. Implementing that shape here means the self-hosted server
 * runs the worker's own request handler and repository code unchanged, instead
 * of a second implementation of the API that could drift from it.
 *
 * Only the surface the worker actually uses is implemented: prepare/bind,
 * first/all/run/raw, and batch. Anything else throws rather than silently
 * doing the wrong thing.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** What D1 reports alongside a result. Row counts are best-effort locally. */
export interface SqliteMeta {
	served_by: string;
	duration: number;
	changes: number;
	last_row_id: number;
	changed_db: boolean;
	rows_read: number;
	rows_written: number;
}

const meta = (durationMs: number, changes = 0, lastRowId = 0, rowsRead = 0): SqliteMeta => ({
	served_by: 'sqlite',
	duration: durationMs,
	changes,
	last_row_id: lastRowId,
	changed_db: changes > 0,
	rows_read: rowsRead,
	rows_written: changes
});

/** SQLite accepts null, number, bigint, string and Uint8Array; map the rest. */
function toSqliteValue(value: unknown): null | number | bigint | string | Uint8Array {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
	if (value instanceof Uint8Array) return value;
	if (value instanceof Date) return value.toISOString();
	throw new TypeError(`Cannot bind ${typeof value} to a SQLite statement`);
}

/**
 * Applied to every connection. D1 tunes its own SQLite; here the server does,
 * and node:sqlite is synchronous, so time spent in a query is time every other
 * request waits.
 */
const CONNECTION_PRAGMAS = [
	// WAL keeps the nightly precompute's writes from blocking API reads.
	'journal_mode = WAL',
	// NORMAL is the recommended pairing with WAL: never corrupts, and at worst
	// loses the last commits on power loss — which the precompute re-runs.
	'synchronous = NORMAL',
	'foreign_keys = ON',
	// Wait rather than fail when the precompute holds a write lock.
	'busy_timeout = 10000',
	// Reads come straight from the OS page cache instead of being copied into
	// SQLite's: ~3x faster wherever a query visits many pages. SQLite caps this
	// at its compile-time maximum (~2GiB).
	'mmap_size = 2147483648',
	// 64 MiB of page cache (negative = KiB), up from 2 MiB.
	'cache_size = -65536',
	// DISTINCT / ORDER BY temp b-trees stay off disk.
	'temp_store = MEMORY',
	// A big transaction (a migration's index build) grows the WAL to hundreds of
	// MB; truncate it back afterwards instead of keeping the file that size.
	'journal_size_limit = 67108864'
];

class SqlitePreparedStatement {
	constructor(
		private readonly statement: StatementSync,
		private readonly params: ReadonlyArray<unknown> = []
	) {}

	/** Returns a new statement, as D1 does — binding never mutates in place. */
	bind(...values: unknown[]): SqlitePreparedStatement {
		return new SqlitePreparedStatement(this.statement, values);
	}

	private get bound(): Array<null | number | bigint | string | Uint8Array> {
		return this.params.map(toSqliteValue);
	}

	/**
	 * Rows exactly as node:sqlite returns them, not copied. Its integers are
	 * already JS numbers — without `readBigInts` it throws on a value too wide for
	 * one rather than returning a bigint — so there is nothing to convert, and
	 * copying every row cost ~40% of a 480k-row field read. They are
	 * null-prototype objects; nothing in the worker relies on Object.prototype
	 * methods of a row.
	 */
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: SqliteMeta }> {
		const started = performance.now();
		const results = this.statement.all(...this.bound) as T[];
		return { results, success: true, meta: meta(performance.now() - started, 0, 0, results.length) };
	}

	/** The first row, or one column of it — null when there are no rows, like D1. */
	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const row = this.statement.get(...this.bound) as Record<string, unknown> | undefined;
		if (row === undefined) return null;
		return (column === undefined ? row : (row[column] ?? null)) as T | null;
	}

	async run(): Promise<{ results: never[]; success: true; meta: SqliteMeta }> {
		const started = performance.now();
		const result = this.statement.run(...this.bound);
		return {
			results: [],
			success: true,
			meta: meta(performance.now() - started, Number(result.changes), Number(result.lastInsertRowid))
		};
	}

	/** Rows as arrays of values rather than objects. */
	async raw<T = unknown[]>(): Promise<T[]> {
		const rows = this.statement.all(...this.bound) as Array<Record<string, unknown>>;
		return rows.map((row) => Object.values(row) as unknown as T);
	}
}

/**
 * A D1Database backed by a SQLite file. Cast to D1Database at the boundary: it
 * implements the methods the worker uses, not the full published interface.
 */
export class SqliteD1 {
	private constructor(private readonly db: DatabaseSync) {}

	static open(path: string): SqliteD1 {
		const db = new DatabaseSync(path);
		for (const pragma of CONNECTION_PRAGMAS) db.exec(`PRAGMA ${pragma}`);
		return new SqliteD1(db);
	}

	prepare(sql: string): SqlitePreparedStatement {
		return new SqlitePreparedStatement(this.db.prepare(sql));
	}

	/**
	 * D1 runs a batch as one transaction; so does this. A failure rolls the whole
	 * batch back, which is what the precompute's writers rely on.
	 */
	async batch<T = Record<string, unknown>>(
		statements: SqlitePreparedStatement[]
	): Promise<Array<{ results: T[]; success: true; meta: SqliteMeta }>> {
		this.db.exec('BEGIN');
		try {
			const results: Array<{ results: T[]; success: true; meta: SqliteMeta }> = [];
			for (const statement of statements) {
				results.push((await statement.all<T>()) as { results: T[]; success: true; meta: SqliteMeta });
			}
			this.db.exec('COMMIT');
			return results;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	/** Run one or more statements for their effect (schema application, PRAGMAs). */
	async exec(sql: string): Promise<{ count: number; duration: number }> {
		const started = performance.now();
		this.execSync(sql);
		return { count: 1, duration: performance.now() - started };
	}

	/**
	 * The same, without the promise. Startup DDL and transaction control need to
	 * run in order relative to each other; an unawaited `exec` only happens to.
	 */
	execSync(sql: string): void {
		this.db.exec(sql);
	}

	/** A synchronous read, for the startup paths that cannot await. */
	selectSync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
		return this.db.prepare(sql).all(...params.map(toSqliteValue)) as T[];
	}

	/**
	 * Gather planner statistics for tables that lack them or have changed a lot
	 * since. Run once the schema is final (after migrations): SQLite's
	 * recommended open-time call, with a sampling limit so the first run on a
	 * multi-million-row table takes ~0.2s rather than ~1.6s for a full ANALYZE.
	 * Afterwards it is a no-op until the data has changed substantially.
	 */
	optimize(): void {
		this.db.exec('PRAGMA analysis_limit = 1000');
		this.db.exec('PRAGMA optimize = 0x10002');
	}

	/** Close, first refreshing statistics the session's queries showed were stale. */
	close(): void {
		try {
			this.db.exec('PRAGMA optimize');
		} catch (error) {
			// Only statistics: never let them stop a shutdown.
			console.warn('PRAGMA optimize on close failed:', error);
		}
		this.db.close();
	}

	/** The worker types this as D1Database; the shim implements what it uses. */
	asD1(): D1Database {
		return this as unknown as D1Database;
	}
}

