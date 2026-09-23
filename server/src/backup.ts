/**
 * Backup of the SQLite file: one daily copy, refreshed each night, and one
 * weekly copy.
 *
 * The database is a cache of Numerai's own data — losing it costs a rebuild,
 * not data — so the question a backup answers here is "was it fine yesterday?"
 * and "was it fine last week?", not "what did it hold on the 14th?". Two fixed
 * names, no accumulation: at ~2.5GB a copy, seven dailies were 17GB of disk
 * nobody would ever read.
 *
 *   tsx src/backup.ts
 *
 * VACUUM INTO writes a consistent, compacted snapshot while the API keeps
 * reading (WAL), and each copy is a plain database file: restoring is stopping
 * the API and putting one back as DATABASE_PATH.
 */

import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteD1 } from './sqlite-d1.js';

export const DAILY_BACKUP = 'numerai-cache-daily.sqlite';
export const WEEKLY_BACKUP = 'numerai-cache-weekly.sqlite';

/** Day the weekly copy is taken, as Date#getUTCDay (0 = Sunday). */
export const WEEKLY_BACKUP_DAY = 0;

/** Copies from the earlier dated scheme (numerai-cache-20260922.sqlite). */
const isLegacyBackup = (name: string): boolean => /^numerai-cache-\d{8}\.sqlite$/.test(name);

/**
 * Snapshot `databasePath` into `backupDir` as the daily copy, plus the weekly
 * copy on the weekly day. Returns the files written.
 */
export function backupDatabase(databasePath: string, backupDir: string, now = new Date()): string[] {
	mkdirSync(backupDir, { recursive: true });

	const daily = join(backupDir, DAILY_BACKUP);
	const partial = `${daily}.partial`;
	rmSync(partial, { force: true });

	const db = SqliteD1.open(databasePath);
	try {
		db.execSync(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
	} finally {
		db.close();
	}
	// Rename last, so a failed run leaves yesterday's copy rather than a
	// truncated file that looks complete.
	renameSync(partial, daily);
	const written = [daily];

	if (now.getUTCDay() === WEEKLY_BACKUP_DAY) {
		const weekly = join(backupDir, WEEKLY_BACKUP);
		// Copy the snapshot just taken rather than vacuuming again: same content,
		// half the work, and the two copies cannot disagree.
		copyFileSync(daily, weekly);
		written.push(weekly);
	}

	for (const name of readdirSync(backupDir)) {
		if (isLegacyBackup(name)) rmSync(join(backupDir, name));
	}
	return written;
}

const invokedDirectly = /backup\.[cm]?ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
	const databasePath = resolve(process.env.DATABASE_PATH?.trim() || './data/numerai-cache.sqlite');
	const backupDir = resolve(process.env.BACKUP_DIR?.trim() || './data/backups');

	const started = Date.now();
	const written = backupDatabase(databasePath, backupDir);
	console.log(`backup written: ${written.join(', ')} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
