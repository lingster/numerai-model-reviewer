/**
 * Bringing a self-hosted database up to date: schema.sql, then migrations.
 *
 * Migrations run at startup here, unlike on Cloudflare where they are run by
 * hand — there they are deliberately manual because building an index on D1
 * writes a row per table row and can exceed a daily quota. On local disk that
 * cost does not exist, so a self-hosted database gets the better
 * (tournament, round_number) index from the start.
 *
 * Each one is applied **once** and recorded. Replaying every migration on every
 * boot is not merely wasteful: a migration that is not idempotent — an
 * `ALTER TABLE ADD COLUMN`, a data backfill — fails or corrupts on the second
 * start. `schema.sql` is different: it is written to be cheap to re-run (see
 * worker/src/schema-safety.test.ts) and is applied every time.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteD1 } from './sqlite-d1.js';

/** Mirrors wrangler's own bookkeeping table, so the two can be reconciled. */
const LEDGER = `CREATE TABLE IF NOT EXISTS applied_migrations (
	name TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** Statements in a SQL file: comments stripped, split on `;`. */
export function splitSqlStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/** Apply schema.sql. Safe on every start; it creates nothing destructively. */
export function applySchema(db: SqliteD1, schemaPath: string): void {
	for (const statement of splitSqlStatements(readFileSync(schemaPath, 'utf-8'))) {
		db.execSync(statement);
	}
}

/** Migration filenames in the order they must run. */
function pending(db: SqliteD1, migrationsPath: string): string[] {
	const applied = new Set(
		db.selectSync<{ name: string }>('SELECT name FROM applied_migrations').map((row) => row.name)
	);
	return readdirSync(migrationsPath)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.filter((name) => !applied.has(name));
}

/**
 * Apply every migration not yet recorded, in filename order, and return their
 * names. Each runs in its own transaction with its ledger row, so a failure
 * leaves the database as if that migration had never started and a corrected
 * version can simply be retried.
 */
export function applyMigrations(db: SqliteD1, migrationsPath: string): string[] {
	if (!existsSync(migrationsPath)) return [];
	db.execSync(LEDGER);

	const applied: string[] = [];
	for (const name of pending(db, migrationsPath)) {
		const statements = splitSqlStatements(readFileSync(join(migrationsPath, name), 'utf-8'));
		db.execSync('BEGIN');
		try {
			for (const statement of statements) db.execSync(statement);
			db.execSync(`INSERT INTO applied_migrations (name) VALUES ('${name.replace(/'/g, "''")}')`);
			db.execSync('COMMIT');
		} catch (error) {
			db.execSync('ROLLBACK');
			throw new Error(`migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error
			});
		}
		applied.push(name);
	}
	return applied;
}
