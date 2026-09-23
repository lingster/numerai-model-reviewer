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

/**
 * migrations/*.sql, applied after schema.sql in filename order — the same way a
 * fresh database is built in CI and local dev.
 */
const migrationSql = Object.entries(
	import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true })
)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([, sql]) => sql as string);

/**
 * Which round index model_performances has. Production D1 still has the original
 * (round_number, tournament) index — migrations/0001 swaps it for
 * (tournament, round_number) but needs a paid plan to run — and migrations/0003
 * widens that into a covering index on the self-hosted database, so query costs
 * are tested against every shape, and against none.
 */
export type RoundIndexShape = 'round_then_tournament' | 'tournament_then_round' | 'covering' | 'none';

const ROUND_INDEX_SQL: Record<RoundIndexShape, string> = {
	round_then_tournament:
		'CREATE INDEX idx_perf_round ON model_performances(round_number, tournament)',
	tournament_then_round:
		'CREATE INDEX idx_perf_tournament_round ON model_performances(tournament, round_number)',
	covering:
		'CREATE INDEX idx_perf_round_field ON model_performances(tournament, round_number, model_name, stake_value, corr, mmc, tc, alpha, mpc)',
	none: ''
};

/** Every round index name above, so switching shape drops whichever is present. */
const ROUND_INDEX_NAMES = ['idx_perf_round', 'idx_perf_tournament_round', 'idx_perf_round_field'];

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

/** Where a metered statement keeps the real one it wraps. */
const REAL_STATEMENT = Symbol('real-statement');

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

	/** A fresh database built like production's: schema.sql, then every migration. */
	static async create(): Promise<D1CostHarness> {
		const miniflare = new Miniflare({
			modules: true,
			script: 'export default { fetch() { return new Response(null) } }',
			d1Databases: ['DB']
		});
		const raw = (await miniflare.getD1Database('DB')) as unknown as D1Database;
		const harness = new D1CostHarness(miniflare, raw);
		await harness.execute(schemaSql);
		for (const migration of migrationSql) await harness.execute(migration);
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
	 *
	 * Metrics vary by model index rather than being constant: a field where every
	 * model scores the same is entirely ties, which hides ranking differences.
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
				 SELECT 't' || CAST(?4 AS INTEGER) || '_m' || i, n,
				        0.05 - i * 0.0001, 0.02 - i * 0.00005, NULL, NULL, NULL,
				        CASE WHEN i % ?5 = 0 THEN 0 ELSE 1.0 END, ?4, 0
				   FROM m, r`
			)
			.bind(models, fromRound, toRound, tournament, unstakedEvery)
			.run();

		await this.raw
			.prepare(
				`WITH RECURSIVE m(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM m WHERE i < ?1 - 1)
				 INSERT OR IGNORE INTO top_staked_models (model_id, model_name, username, stake_value, tournament, updated_at)
				 SELECT 'id-' || CAST(?2 AS INTEGER) || '-' || i, 't' || CAST(?2 AS INTEGER) || '_m' || i,
				        'user' || i, 1.0, ?2, 0
				   FROM m`
			)
			.bind(models, tournament)
			.run();
	}

	/**
	 * Tables, indexes and other objects in sqlite_master. Code that inspects the
	 * schema pays roughly this many reads — a cost bounded by the schema, not the
	 * data — so budgets for it are stated in these terms.
	 */
	async schemaObjectCount(): Promise<number> {
		const row = await this.raw.prepare('SELECT COUNT(*) AS n FROM sqlite_master').first<{ n: number }>();
		return row?.n ?? 0;
	}

	/** Give model_performances exactly the round index `shape` describes. */
	async setRoundIndex(shape: RoundIndexShape): Promise<void> {
		const drops = ROUND_INDEX_NAMES.map((name) => `DROP INDEX IF EXISTS ${name};`).join(' ');
		await this.execute(`${drops} ${ROUND_INDEX_SQL[shape]}`);
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
		// The proxy carries the statement it wraps: batch() has to hand D1 the real
		// ones, which cannot be reconstructed from the proxy's methods.
		const unwrap = (statement: D1PreparedStatement): D1PreparedStatement =>
			(statement as { [REAL_STATEMENT]?: D1PreparedStatement })[REAL_STATEMENT] ?? statement;

		const meter = (statement: D1PreparedStatement): D1PreparedStatement =>
			({
				[REAL_STATEMENT]: statement,
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
				const results = await this.raw.batch(statements.map(unwrap));
				results.forEach((result) => this.record(result));
				return results;
			}
		} as unknown as D1Database;
	}
}
