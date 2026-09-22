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

/** Split a CREATE TABLE body on its top-level commas, ignoring nested parens. */
function splitDefinitions(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const character of body) {
		if (character === '(') depth++;
		else if (character === ')') depth--;
		if (character === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += character;
	}
	parts.push(current);
	return parts;
}

/**
 * Column definitions in each `CREATE TABLE` of a schema file, by table name.
 * Deliberately simple: schema.sql is ours, and table-level constraints are
 * recognised by their leading keyword rather than parsed.
 */
function declaredColumns(schemaSql: string): Map<string, Map<string, string>> {
	const withoutComments = schemaSql.replace(/--[^\n]*/g, '');
	const tables = new Map<string, Map<string, string>>();
	const CREATE = /CREATE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
	for (const [, table, body] of withoutComments.matchAll(CREATE)) {
		const columns = new Map<string, string>();
		for (const definition of splitDefinitions(body)) {
			const [name, ...rest] = definition.trim().split(/\s+/);
			if (!name || rest.length === 0) continue;
			if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(name)) continue;
			columns.set(name, rest.join(' '));
		}
		tables.set(table, columns);
	}
	return tables;
}

/**
 * Add columns that schema.sql declares but an existing table lacks, and return
 * their `table.column` names.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, and
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a new column could otherwise
 * only reach an existing database through a migration — which then fails on a
 * fresh one, where schema.sql has already created it. Doing it here keeps
 * schema.sql the single description of the shape for both deployments.
 *
 * Additive only: nothing is dropped, retyped or reordered. Those belong in
 * migrations/, where they are applied once and reviewed.
 */
export function syncSchemaColumns(db: SqliteD1, schemaPath: string): string[] {
	const added: string[] = [];
	for (const [table, columns] of declaredColumns(readFileSync(schemaPath, 'utf-8'))) {
		const existing = new Set(
			db.selectSync<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name)
		);
		if (existing.size === 0) continue; // table does not exist yet; schema.sql creates it
		for (const [name, definition] of columns) {
			if (existing.has(name)) continue;
			// A default that is not constant would need a table rebuild; keep it simple.
			db.execSync(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition.replace(/PRIMARY KEY.*/i, '').trim()}`);
			added.push(`${table}.${name}`);
		}
	}
	return added;
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
