/**
 * Unit tests for the wrangler D1 CLI helpers used by precompute.
 *
 * execSync's Error.message is only "Command failed: <cmd>"; the reason wrangler
 * gave (e.g. the D1 read-quota message) is on stderr. Dropping stderr is why the
 * 2026-09 backfill incidents logged no cause.
 */
import { describe, it, expect } from 'vitest';
import {
	createWranglerQuery,
	execErrorDetail,
	parseWranglerJsonRows,
	type CommandRunner
} from './wrangler-d1';

/** execSync returns Buffers when no encoding is given; built here without Node types. */
const bytes = (text: string): { toString(): string } => ({ toString: () => text });

describe('execErrorDetail', () => {
	it('prefers what the command wrote to stderr over the generic message', () => {
		const error = Object.assign(new Error('Command failed: wrangler d1 execute ...'), {
			stderr: "Your account has exceeded D1's free tier daily row read limit",
			stdout: ''
		});
		expect(execErrorDetail(error)).toContain('exceeded D1');
	});

	it('includes stdout too, since wrangler reports some failures there', () => {
		const error = Object.assign(new Error('Command failed'), {
			stderr: '',
			stdout: '{"error":"storage operation exceeded timeout"}'
		});
		expect(execErrorDetail(error)).toContain('exceeded timeout');
	});

	it('handles Buffer output, which execSync returns without an encoding', () => {
		const error = Object.assign(new Error('Command failed'), {
			stderr: bytes('quota exceeded'),
			stdout: bytes('')
		});
		expect(execErrorDetail(error)).toContain('quota exceeded');
	});

	it('falls back to the message when the command produced no output', () => {
		expect(execErrorDetail(new Error('spawn wrangler ENOENT'))).toBe('spawn wrangler ENOENT');
	});

	it('copes with values that are not Errors', () => {
		expect(execErrorDetail('boom')).toBe('boom');
	});
});

describe('parseWranglerJsonRows', () => {
	it('reads the rows of the first statement result', () => {
		const out = JSON.stringify([{ results: [{ maxRound: 1348 }], success: true, meta: {} }]);
		expect(parseWranglerJsonRows(out)).toEqual([{ maxRound: 1348 }]);
	});

	it('accepts a bare object result as well as an array of them', () => {
		const out = JSON.stringify({ results: [{ maxRound: 7 }] });
		expect(parseWranglerJsonRows(out)).toEqual([{ maxRound: 7 }]);
	});

	it('throws on output that has no results array, instead of returning no rows', () => {
		expect(() => parseWranglerJsonRows(JSON.stringify([{ success: false }]))).toThrow(/results/);
		expect(() => parseWranglerJsonRows('not json')).toThrow();
	});
});

describe('createWranglerQuery', () => {
	const ok = (rows: unknown[]): CommandRunner => () => JSON.stringify([{ results: rows }]);

	it('targets the remote database unless told otherwise', async () => {
		let command = '';
		const run: CommandRunner = (cmd) => {
			command = cmd;
			return JSON.stringify([{ results: [] }]);
		};
		await createWranglerQuery(run, false)('SELECT 1');
		expect(command).toContain('d1 execute numerai-cache --remote');
		expect(command).toContain('--json');

		await createWranglerQuery(run, true)('SELECT 1');
		expect(command).toContain('--local');
	});

	it('passes the SQL as a single quoted argument', async () => {
		let command = '';
		const run: CommandRunner = (cmd) => {
			command = cmd;
			return JSON.stringify([{ results: [] }]);
		};
		await createWranglerQuery(run, false)('SELECT "a" FROM t WHERE x = 1');
		expect(command).toContain('--command "SELECT \\"a\\" FROM t WHERE x = 1"');
	});

	it('resolves with the parsed result rows', async () => {
		await expect(createWranglerQuery(ok([{ maxRound: 9 }]), false)('SELECT 1')).resolves.toEqual([
			{ maxRound: 9 }
		]);
	});

	it("rejects with wrangler's stderr when the command fails", async () => {
		const run: CommandRunner = () => {
			throw Object.assign(new Error('Command failed: wrangler d1 execute'), {
				stderr: "exceeded D1's free tier daily row read limit"
			});
		};
		await expect(createWranglerQuery(run, false)('SELECT 1')).rejects.toThrow(/read limit/);
	});
});
