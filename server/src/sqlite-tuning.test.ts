/**
 * Connection tuning for the self-hosted database, and the query plans it buys.
 *
 * On D1, Cloudflare runs the database; here the server does, and node:sqlite is
 * synchronous — a slow query stalls every other request. So the connection is
 * tuned for reads (memory-mapped I/O, a larger page cache), keeps planner
 * statistics current, and the hot rankings queries are pinned to the plans that
 * make them cheap against the real schema and migrations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteD1 } from './sqlite-d1.js';
import { applyMigrations, applySchema } from './migrations.js';

let directory: string;
let db: SqliteD1;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-tuning-'));
	db = SqliteD1.open(join(directory, 'test.sqlite'));
});

afterEach(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

const pragma = (name: string): unknown => Object.values(db.selectSync(`PRAGMA ${name}`)[0] ?? {})[0];

describe('connection pragmas', () => {
	it('uses WAL with NORMAL sync, which WAL makes safe against corruption', () => {
		expect(pragma('journal_mode')).toBe('wal');
		expect(pragma('synchronous')).toBe(1); // NORMAL
	});

	it('memory-maps the file and keeps a larger page cache for the field reads', () => {
		expect(pragma('mmap_size')).toBeGreaterThanOrEqual(1 << 30);
		expect(pragma('cache_size')).toBe(-65_536); // KiB: 64 MiB
	});

	it('keeps temporary b-trees in memory and caps the WAL left behind by a big write', () => {
		expect(pragma('temp_store')).toBe(2); // MEMORY
		expect(pragma('journal_size_limit')).toBe(64 * 1024 * 1024);
	});

	it('waits for a writer rather than failing', () => {
		expect(pragma('busy_timeout')).toBe(10_000);
	});
});

describe('optimize', () => {
	it('gathers planner statistics for tables that have none', async () => {
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER); CREATE INDEX t_a ON t(a)');
		await db.exec('WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 500) INSERT INTO t SELECT i % 7, i FROM r');

		db.optimize();

		expect(db.selectSync<{ tbl: string }>('SELECT tbl FROM sqlite_stat1').map((row) => row.tbl)).toContain('t');
	});
});

describe('query plans on the real schema and migrations', () => {
	beforeEach(() => {
		applySchema(db, resolve('../worker/src/schema.sql'));
		applyMigrations(db, resolve('../worker/migrations'));
	});

	const plan = (sql: string, ...params: unknown[]): string =>
		db
			.selectSync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
			.map((row) => row.detail)
			.join(' | ');

	it("reads a round's staked field from the covering index, with no table lookups", () => {
		expect(
			plan(
				`SELECT round_number, model_name, corr, mmc, tc, alpha, mpc, stake_value FROM model_performances
				  WHERE round_number BETWEEN ? AND ? AND tournament = ? AND stake_value IS NOT NULL AND stake_value > 0`,
				1170,
				1289,
				8
			)
		).toMatch(/USING COVERING INDEX idx_perf_round_field \(tournament=\? AND round_number>\? AND round_number<\?\)/);
	});

	it('finds a tournament span with a seek on each end', () => {
		expect(plan('SELECT MAX(round_number) FROM model_performances WHERE tournament = 8')).toMatch(
			/COVERING INDEX idx_perf_round_field \(tournament=\?\)/
		);
	});
});
