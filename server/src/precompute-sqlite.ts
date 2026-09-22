/**
 * Precompute into the server's SQLite file.
 *
 *   tsx src/precompute-sqlite.ts --tournament 8 --top-n 1000000 --refresh-overlap 70 --no-cache
 *
 * Takes the worker precompute's own flags (see worker/src/precompute.ts); the
 * database is DATABASE_PATH, as for the API. --local / --remote are ignored.
 * Closing runs PRAGMA optimize, so planner statistics follow each night's writes.
 */

import { runPrecompute } from '../../worker/src/precompute.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createSqliteTarget } from './sqlite-target.js';

const config = loadConfig();
const db = openDatabase(config);

try {
	await runPrecompute(() => createSqliteTarget(db, config.databasePath));
} catch (error) {
	console.error('Fatal error:', error);
	process.exitCode = 1;
} finally {
	db.close();
}
