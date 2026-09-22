import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, pruneBackups } from './backup.js';
import { SqliteD1 } from './sqlite-d1.js';

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-backup-'));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('backupDatabase', () => {
	it('writes a dated, complete copy that opens as a database', () => {
		const source = join(directory, 'live.sqlite');
		const db = SqliteD1.open(source);
		db.execSync('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3);');
		db.close();

		const written = backupDatabase(source, join(directory, 'backups'), new Date('2026-09-22T03:00:00Z'));

		expect(written).toBe(join(directory, 'backups', 'numerai-cache-20260922.sqlite'));
		const copy = SqliteD1.open(written);
		expect(copy.selectSync<{ n: number }>('SELECT COUNT(*) AS n FROM t')[0].n).toBe(3);
		copy.close();
		expect(readdirSync(join(directory, 'backups')).some((name) => name.endsWith('.partial'))).toBe(false);
	});
});

describe('pruneBackups', () => {
	it('keeps the newest N and ignores other files', () => {
		for (const day of ['20260918', '20260919', '20260920', '20260921']) {
			writeFileSync(join(directory, `numerai-cache-${day}.sqlite`), '');
		}
		writeFileSync(join(directory, 'notes.txt'), '');

		expect(pruneBackups(directory, 2)).toEqual(['numerai-cache-20260918.sqlite', 'numerai-cache-20260919.sqlite']);
		expect(readdirSync(directory).sort()).toEqual([
			'notes.txt',
			'numerai-cache-20260920.sqlite',
			'numerai-cache-20260921.sqlite'
		]);
	});
});
