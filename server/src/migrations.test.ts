/**
 * Migrations are applied once and recorded, not replayed on every boot.
 *
 * Replaying them is not merely wasteful: a migration that is not idempotent —
 * an `ALTER TABLE ADD COLUMN`, a data backfill — fails or corrupts on the second
 * start, and the ones here rebuild an index over the whole table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from './sqlite-d1.js';
import { applyMigrations, applySchema } from './migrations.js';

let directory: string;
let migrationsPath: string;
let db: SqliteD1;

const migration = (name: string, sql: string) => writeFileSync(join(migrationsPath, name), sql);

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-migrations-'));
	migrationsPath = join(directory, 'migrations');
	mkdirSync(migrationsPath);
	db = SqliteD1.open(join(directory, 'test.sqlite'));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe('applyMigrations', () => {
	it('applies each migration once', () => {
		migration('0001_first.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');
		expect(applyMigrations(db, migrationsPath)).toEqual(['0001_first.sql']);
	});

	it('does not replay a migration on the next start', () => {
		// Not idempotent on purpose: a second run would throw "duplicate column".
		migration('0001_first.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');
		migration('0002_second.sql', 'ALTER TABLE widgets ADD COLUMN label TEXT;');
		applyMigrations(db, migrationsPath);

		expect(applyMigrations(db, migrationsPath)).toEqual([]);
	});

	it('applies only the migrations added since the last start', () => {
		migration('0001_first.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');
		applyMigrations(db, migrationsPath);

		migration('0002_second.sql', 'ALTER TABLE widgets ADD COLUMN label TEXT;');
		expect(applyMigrations(db, migrationsPath)).toEqual(['0002_second.sql']);
	});

	it('applies them in filename order, not directory order', () => {
		migration('0002_second.sql', 'ALTER TABLE widgets ADD COLUMN label TEXT;');
		migration('0001_first.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');

		expect(applyMigrations(db, migrationsPath)).toEqual(['0001_first.sql', '0002_second.sql']);
	});

	it('records nothing when a migration fails, so a fixed migration can be retried', () => {
		migration('0001_broken.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY); NOT VALID SQL;');
		expect(() => applyMigrations(db, migrationsPath)).toThrow();

		// The half-applied table must be rolled back too, or the retry hits
		// "table already exists" and can never succeed.
		migration('0001_broken.sql', 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);');
		expect(applyMigrations(db, migrationsPath)).toEqual(['0001_broken.sql']);
	});

	it('tolerates a missing migrations directory', () => {
		expect(applyMigrations(db, join(directory, 'absent'))).toEqual([]);
	});
});

describe('applySchema', () => {
	it('is re-runnable, because schema.sql is every start', () => {
		const schemaPath = join(directory, 'schema.sql');
		writeFileSync(schemaPath, 'CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY);');

		applySchema(db, schemaPath);
		expect(() => applySchema(db, schemaPath)).not.toThrow();
	});
});
