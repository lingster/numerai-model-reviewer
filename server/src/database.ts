/**
 * Opening the database the way every process on this server must: schema and
 * migrations applied, planner statistics fresh. Shared by the API and the
 * scheduled jobs so neither can run against a half-migrated file.
 */

import { SqliteD1 } from './sqlite-d1.js';
import { applyMigrations, applySchema } from './migrations.js';
import type { ServerConfig } from './config.js';

export function openDatabase(
	config: Pick<ServerConfig, 'databasePath' | 'applySchema' | 'schemaPath' | 'migrationsPath'>
): SqliteD1 {
	const sqlite = SqliteD1.open(config.databasePath);
	if (config.applySchema) {
		applySchema(sqlite, config.schemaPath);
		const applied = applyMigrations(sqlite, config.migrationsPath);
		if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
	}
	try {
		sqlite.optimize();
	} catch (error) {
		// Statistics only improve plans; a busy or read-only database still serves.
		console.warn('PRAGMA optimize at startup failed:', error);
	}
	return sqlite;
}
