/**
 * Nightly backup of the SQLite file, keeping the newest BACKUP_KEEP copies.
 *
 *   tsx src/backup.ts
 *
 * VACUUM INTO writes a consistent, compacted snapshot while the API keeps
 * reading (WAL), and the copy is a plain database file: restoring is stopping
 * the API and putting it back as DATABASE_PATH.
 */

import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteD1 } from './sqlite-d1.js';

const PREFIX = 'numerai-cache-';
const SUFFIX = '.sqlite';

/** Snapshot `databasePath` into `backupDir` as numerai-cache-<UTC date>.sqlite; returns its path. */
export function backupDatabase(databasePath: string, backupDir: string, now = new Date()): string {
	mkdirSync(backupDir, { recursive: true });
	const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
	const target = join(backupDir, `${PREFIX}${stamp}${SUFFIX}`);
	const partial = `${target}.partial`;
	rmSync(partial, { force: true });

	const db = SqliteD1.open(databasePath);
	try {
		db.execSync(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
	} finally {
		db.close();
	}
	// Rename last, so a failed run never leaves a truncated file that looks complete.
	renameSync(partial, target);
	return target;
}

/** Delete all but the newest `keep` backups; returns the deleted file names. */
export function pruneBackups(backupDir: string, keep: number): string[] {
	const backups = readdirSync(backupDir)
		.filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
		.sort(); // the date stamp sorts chronologically
	const expired = backups.slice(0, Math.max(0, backups.length - keep));
	for (const name of expired) rmSync(join(backupDir, name));
	return expired;
}

const invokedDirectly = /backup\.[cm]?ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
	const databasePath = resolve(process.env.DATABASE_PATH?.trim() || './data/numerai-cache.sqlite');
	const backupDir = resolve(process.env.BACKUP_DIR?.trim() || './data/backups');
	const keep = Number.parseInt(process.env.BACKUP_KEEP?.trim() || '7', 10);
	if (!Number.isInteger(keep) || keep < 1) throw new RangeError(`BACKUP_KEEP must be at least 1`);

	const started = Date.now();
	const written = backupDatabase(databasePath, backupDir);
	const pruned = pruneBackups(backupDir, keep);
	console.log(`backup written: ${written} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
	if (pruned.length > 0) console.log(`backups pruned: ${pruned.join(', ')}`);
}
