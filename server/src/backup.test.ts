/**
 * The backup keeps one daily and one weekly copy — no more.
 *
 * The database is a cache of Numerai's own data: a lost copy costs a rebuild,
 * not data. Two copies (~2.5GB each) cover "yesterday was fine" and "last week
 * was fine"; seven dailies just cost disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, DAILY_BACKUP, WEEKLY_BACKUP } from './backup.js';
import { SqliteD1 } from './sqlite-d1.js';

let directory: string;
let source: string;
let backups: string;

const rowCount = (path: string): number => {
	const db = SqliteD1.open(path);
	try {
		return db.selectSync<{ n: number }>('SELECT COUNT(*) AS n FROM t')[0].n;
	} finally {
		db.close();
	}
};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-backup-'));
	source = join(directory, 'live.sqlite');
	backups = join(directory, 'backups');
	const db = SqliteD1.open(source);
	db.execSync('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3);');
	db.close();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('backupDatabase', () => {
	it('writes the daily copy, and nothing else on an ordinary day', () => {
		// Thursday.
		const written = backupDatabase(source, backups, new Date('2026-09-24T03:00:00Z'));

		expect(written).toEqual([join(backups, DAILY_BACKUP)]);
		expect(readdirSync(backups)).toEqual([DAILY_BACKUP]);
		expect(rowCount(join(backups, DAILY_BACKUP))).toBe(3);
	});

	it('also refreshes the weekly copy on the weekly day', () => {
		// Sunday.
		const written = backupDatabase(source, backups, new Date('2026-09-27T03:00:00Z'));

		expect(written).toEqual([join(backups, DAILY_BACKUP), join(backups, WEEKLY_BACKUP)]);
		expect(rowCount(join(backups, WEEKLY_BACKUP))).toBe(3);
	});

	it('replaces yesterday\'s daily rather than accumulating copies', () => {
		backupDatabase(source, backups, new Date('2026-09-24T03:00:00Z'));
		const db = SqliteD1.open(source);
		db.execSync('INSERT INTO t VALUES (4);');
		db.close();

		backupDatabase(source, backups, new Date('2026-09-25T03:00:00Z'));

		expect(readdirSync(backups)).toEqual([DAILY_BACKUP]);
		expect(rowCount(join(backups, DAILY_BACKUP))).toBe(4);
	});

	it('clears out dated copies left by the previous scheme', () => {
		backupDatabase(source, backups, new Date('2026-09-24T03:00:00Z'));
		writeFileSync(join(backups, 'numerai-cache-20260921.sqlite'), '');

		backupDatabase(source, backups, new Date('2026-09-25T03:00:00Z'));

		expect(readdirSync(backups)).toEqual([DAILY_BACKUP]);
	});
});
