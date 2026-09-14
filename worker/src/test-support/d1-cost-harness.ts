/**
 * A real D1 (Miniflare's, i.e. workerd's SQLite) for measuring what queries
 * cost in the units Cloudflare bills: rows read and rows written.
 *
 * `wrangler d1 execute --local` does not report those counts, but the D1
 * binding's result meta does, and it counts the same way production does — a
 * full scan reads every row, an index seek reads one, and each index on a table
 * adds a written row per insert. Tests use this to turn "this query must not
 * scan the table" into an assertion that fails when it does.
 */

import { Miniflare } from 'miniflare';
import schemaSql from '../schema.sql?raw';

/** Rows D1 billed for some work. */
export interface D1Cost {
	rowsRead: number;
	rowsWritten: number;
}

/** A slice of the rankings fleet: `models` models scored for rounds [fromRound, toRound]. */
export interface FleetSlice {
	tournament: number;
	models: number;
	fromRound: number;
	toRound: number;
	/** Every Nth model is unstaked (stake 0), to exercise the staked-field filter. */
	unstakedEvery: number;
}

interface ResultWithMeta {
	meta?: { rows_read?: number; rows_written?: number };
}

/** Statements in a schema file: comments stripped, split on `;`. */
export function splitSqlStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/** The model name a fleet slice gives its `index`th model. Lowercase, like Numerai's. */
export const fleetModelName = (tournament: number, index: number): string => `t${tournament}_m${index}`;

export class D1CostHarness {
	private readonly cost: D1Cost = { rowsRead: 0, rowsWritten: 0 };

	private constructor(
		private readonly miniflare: Miniflare,
		private readonly raw: D1Database
	) {}

	/** A fresh database with the production schema applied. */
	static async create(): Promise<D1CostHarness> {
		const miniflare = new Miniflare({
			modules: true,
			script: 'export default { fetch() { return new Response(null) } }',
			d1Databases: ['DB']
		});
		const raw = (await miniflare.getD1Database('DB')) as unknown as D1Database;
		const harness = new D1CostHarness(miniflare, raw);
		await harness.execute(schemaSql);
		return harness;
	}

	/** Run every statement in `sql` against the unmetered database. */
	async execute(sql: string): Promise<void> {
		for (const statement of splitSqlStatements(sql)) {
			await this.raw.prepare(statement).run();
		}
	}

	/**
	 * Insert a fleet slice in one statement. Generated in SQL rather than bound
	 * row by row, so seeding a production-shaped table takes about a second.
	 *
	 * D1 binds JS numbers as REAL, so ids are CAST before being concatenated into
	 * names — otherwise tournament 8 yields "t8.0_m0" rather than "t8_m0".
	 */
	async seed(slice: FleetSlice): Promise<void> {
		const { tournament, models, fromRound, toRound, unstakedEvery } = slice;
		await this.raw
			.prepare(
				`WITH RECURSIVE
				   m(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM m WHERE i < ?1 - 1),
				   r(n) AS (SELECT ?2 UNION ALL SELECT n + 1 FROM r WHERE n < ?3)
				 INSERT INTO model_performances
				   (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at)
				 SELECT 't' || CAST(?4 AS INTEGER) || '_m' || i, n, 0.01, 0.02, NULL, NULL, NULL,
				        CASE WHEN i % ?5 = 0 THEN 0 ELSE 1.0 END, ?4, 0
				   FROM m, r`
			)
			.bind(models, fromRound, toRound, tournament, unstakedEvery)
			.run();

		await this.raw
			.prepare(
				`WITH RECURSIVE m(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM m WHERE i < ?1 - 1)
				 INSERT INTO top_staked_models (model_id, model_name, username, stake_value, tournament, updated_at)
				 SELECT 'id-' || CAST(?2 AS INTEGER) || '-' || i, 't' || CAST(?2 AS INTEGER) || '_m' || i,
				        'user' || i, 1.0, ?2, 0
				   FROM m`
			)
			.bind(models, tournament)
			.run();
	}

	/**
	 * Run `work` against a metered view of the database and return what D1
	 * billed for it, alongside its result.
	 */
	async measure<T>(work: (db: D1Database) => Promise<T>): Promise<{ result: T; cost: D1Cost }> {
		this.cost.rowsRead = 0;
		this.cost.rowsWritten = 0;
		const result = await work(this.metered());
		return { result, cost: { ...this.cost } };
	}

	async dispose(): Promise<void> {
		await this.miniflare.dispose();
	}

	private record(result: ResultWithMeta): void {
		this.cost.rowsRead += result.meta?.rows_read ?? 0;
		this.cost.rowsWritten += result.meta?.rows_written ?? 0;
	}

	/** A D1Database whose statements add their billed rows to `cost`. */
	private metered(): D1Database {
		const meter = (statement: D1PreparedStatement): D1PreparedStatement =>
			({
				bind: (...values: unknown[]) => meter(statement.bind(...values)),
				all: async () => {
					const result = await statement.all();
					this.record(result);
					return result;
				},
				run: async () => {
					const result = await statement.run();
					this.record(result);
					return result;
				},
				// first() returns no meta, so run it as all(); D1 reads the same rows either way.
				first: async (column?: string) => {
					const result = await statement.all<Record<string, unknown>>();
					this.record(result);
					const row = result.results[0] ?? null;
					return column === undefined ? row : (row?.[column] ?? null);
				}
			}) as unknown as D1PreparedStatement;

		return {
			prepare: (sql: string) => meter(this.raw.prepare(sql)),
			batch: async (statements: D1PreparedStatement[]) => {
				const results = await this.raw.batch(statements);
				results.forEach((result) => this.record(result));
				return results;
			}
		} as unknown as D1Database;
	}
}
