/**
 * The SQLite adapter has to behave like D1 closely enough that the worker's
 * repository code cannot tell the difference — that is the whole basis for
 * running one implementation in two places. These tests pin the behaviours the
 * worker actually depends on, including the ones that differ from a naive
 * SQLite wrapper: bind() returning a new statement, first() returning null
 * rather than undefined, and batch() being one transaction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from './sqlite-d1.js';

let db: SqliteD1;

const open = (): SqliteD1 => {
	db = SqliteD1.open(':memory:');
	return db;
};

afterEach(() => db?.close());

const seeded = async (): Promise<SqliteD1> => {
	const sqlite = open();
	await sqlite.exec(`CREATE TABLE models (
		model_name TEXT NOT NULL,
		tournament INTEGER NOT NULL,
		corr REAL,
		PRIMARY KEY (model_name, tournament)
	)`);
	await sqlite
		.prepare("INSERT INTO models VALUES ('alpha', 8, 0.05), ('bravo', 8, NULL), ('charlie', 11, 0.01)")
		.run();
	return sqlite;
};

describe('statements', () => {
	it('binds positional parameters', async () => {
		const sqlite = await seeded();
		const { results } = await sqlite
			.prepare('SELECT model_name FROM models WHERE tournament = ? AND corr > ?')
			.bind(8, 0.01)
			.all<{ model_name: string }>();
		expect(results.map((r) => r.model_name)).toEqual(['alpha']);
	});

	it('returns a new statement from bind, so one prepared statement serves many calls', async () => {
		const sqlite = await seeded();
		const statement = sqlite.prepare('SELECT model_name FROM models WHERE tournament = ?');
		const classic = await statement.bind(8).all<{ model_name: string }>();
		const signals = await statement.bind(11).all<{ model_name: string }>();
		expect(classic.results).toHaveLength(2);
		expect(signals.results).toHaveLength(1);
	});

	it('first() gives null for no rows, not undefined', async () => {
		const sqlite = await seeded();
		const row = await sqlite.prepare('SELECT model_name FROM models WHERE tournament = ?').bind(99).first();
		expect(row).toBeNull();
	});

	it('first(column) gives that column, and null when the value is NULL', async () => {
		const sqlite = await seeded();
		const name = await sqlite
			.prepare('SELECT model_name, corr FROM models WHERE model_name = ?')
			.bind('alpha')
			.first<string>('model_name');
		expect(name).toBe('alpha');

		const corr = await sqlite
			.prepare('SELECT corr FROM models WHERE model_name = ?')
			.bind('bravo')
			.first<number>('corr');
		expect(corr).toBeNull();
	});

	it('keeps SQL NULL as null, not the string "null"', async () => {
		// The wrangler CLI renders NULL as "null", which cost us a production bug.
		const sqlite = await seeded();
		const { results } = await sqlite.prepare('SELECT corr FROM models WHERE model_name = ?').bind('bravo').all();
		expect(results[0].corr).toBeNull();
	});

	it('reports changes from run()', async () => {
		const sqlite = await seeded();
		const result = await sqlite.prepare('UPDATE models SET corr = ? WHERE tournament = ?').bind(0.2, 8).run();
		expect(result.meta.changes).toBe(2);
		expect(result.meta.rows_written).toBe(2);
	});

	it('binds null for undefined, as D1 does', async () => {
		const sqlite = await seeded();
		await sqlite.prepare('INSERT INTO models VALUES (?, ?, ?)').bind('delta', 8, undefined).run();
		const row = await sqlite.prepare('SELECT corr FROM models WHERE model_name = ?').bind('delta').first<{ corr: number | null }>();
		expect(row?.corr).toBeNull();
	});

	it('returns integers as numbers, so arithmetic on round numbers works', async () => {
		const sqlite = open();
		await sqlite.exec('CREATE TABLE rounds (n INTEGER)');
		await sqlite.prepare('INSERT INTO rounds VALUES (1354)').run();
		const row = await sqlite.prepare('SELECT MAX(n) AS latest FROM rounds').first<{ latest: number }>();
		expect(row?.latest).toBe(1354);
		expect(typeof row?.latest).toBe('number');
	});

	it('supports the recursive CTE the coverage query walks rounds with', async () => {
		const sqlite = open();
		await sqlite.exec('CREATE TABLE rounds (n INTEGER, t INTEGER)');
		await sqlite.prepare('INSERT INTO rounds VALUES (1, 8), (2, 8), (3, 12)').run();
		const row = await sqlite
			.prepare(
				`WITH RECURSIVE up(n) AS (
				   SELECT MIN(n) FROM rounds
				   UNION ALL
				   SELECT (SELECT MIN(n) FROM rounds WHERE n > up.n) FROM up
				    WHERE up.n IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rounds WHERE n = up.n AND t = 12)
				 )
				 SELECT MAX(n) AS earliest FROM up`
			)
			.first<{ earliest: number }>();
		expect(row?.earliest).toBe(3);
	});
});

describe('batch', () => {
	it('applies every statement', async () => {
		const sqlite = await seeded();
		const insert = sqlite.prepare('INSERT INTO models VALUES (?, ?, ?)');
		await sqlite.batch([insert.bind('echo', 8, 0.1), insert.bind('foxtrot', 8, 0.2)]);
		const row = await sqlite.prepare('SELECT COUNT(*) AS n FROM models').first<{ n: number }>();
		expect(row?.n).toBe(5);
	});

	it('rolls the whole batch back when one statement fails', async () => {
		const sqlite = await seeded();
		const insert = sqlite.prepare('INSERT INTO models VALUES (?, ?, ?)');
		await expect(
			// 'alpha' already exists for tournament 8: the second insert violates the key.
			sqlite.batch([insert.bind('golf', 8, 0.1), insert.bind('alpha', 8, 0.3)])
		).rejects.toThrow();

		const row = await sqlite.prepare('SELECT COUNT(*) AS n FROM models WHERE model_name = ?').bind('golf').first<{ n: number }>();
		expect(row?.n).toBe(0);
	});
});

describe('schema', () => {
	it('applies the worker schema and accepts its inserts', async () => {
		const sqlite = open();
		await sqlite.exec(`CREATE TABLE IF NOT EXISTS round_field_metrics (
			tournament INTEGER NOT NULL,
			round_number INTEGER NOT NULL,
			corr_values TEXT NOT NULL,
			mmc_values TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (tournament, round_number)
		)`);
		await sqlite
			.prepare('INSERT OR REPLACE INTO round_field_metrics VALUES (?, ?, ?, ?, ?)')
			.bind(8, 1354, 'AAAA', 'BBBB', 0)
			.run();
		const row = await sqlite
			.prepare('SELECT corr_values FROM round_field_metrics WHERE tournament = ? AND round_number = ?')
			.bind(8, 1354)
			.first<{ corr_values: string }>();
		expect(row?.corr_values).toBe('AAAA');
	});
});
