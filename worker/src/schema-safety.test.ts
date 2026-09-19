/**
 * schema.sql is re-applied to the production D1 on every worker deploy
 * (deploy-worker.yml, "Apply D1 schema"), so re-running it must always be cheap
 * and must never change production's structure by surprise.
 *
 * That rules out two kinds of statement:
 *  - Building an index that production does not already have. On an existing
 *    table, CREATE INDEX writes one row per table row — measured at ~5M rows
 *    for model_performances, about 50 days of the free plan's write limit.
 *  - Dropping anything. A DROP INDEX that lands without its replacement leaves
 *    every rankings query scanning the full table.
 *
 * Those changes belong in migrations/, which are run deliberately.
 */
import { describe, expect, it } from 'vitest';
import schemaSql from './schema.sql?raw';
import { splitSqlStatements } from './test-support/d1-cost-harness';

/**
 * Indexes schema.sql may declare: ones production already has and that are not
 * being replaced, so re-creating them with IF NOT EXISTS is a no-op. Only add a
 * name once it exists in production.
 *
 * The round index is deliberately absent. Production's idx_perf_round is being
 * replaced by idx_perf_tournament_round in migrations/0001; keeping either here
 * would rebuild one of them (~5M writes) on the next deploy after the swap.
 */
const INDEXES_OWNED_BY_SCHEMA = new Set(['idx_cache_ttl']);

const statements = splitSqlStatements(schemaSql);

describe('schema.sql is safe to re-apply to production on every deploy', () => {
	it('drops nothing', () => {
		const drops = statements.filter((s) => /^\s*DROP\b/i.test(s));
		expect(drops).toEqual([]);
	});

	it('only creates indexes production already has and keeps', () => {
		const created = statements
			.map((s) => s.match(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i)?.[1])
			.filter((name): name is string => Boolean(name));
		expect(created.filter((name) => !INDEXES_OWNED_BY_SCHEMA.has(name))).toEqual([]);
	});

	it('creates tables idempotently', () => {
		const unguarded = statements.filter(
			(s) => /^\s*CREATE\s+TABLE\b/i.test(s) && !/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(s)
		);
		expect(unguarded).toEqual([]);
	});
});
