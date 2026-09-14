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
	const rowsOutput = (rows: unknown[]) => JSON.stringify([{ results: rows }]);
	const ok = (rows: unknown[]): CommandRunner => () => rowsOutput(rows);

	/** A runner that records the argument list it was given. */
	function recording(): { run: CommandRunner; calls: Array<{ file: string; args: string[] }> } {
		const calls: Array<{ file: string; args: string[] }> = [];
		return {
			calls,
			run: (file, args) => {
				calls.push({ file, args });
				return rowsOutput([]);
			}
		};
	}

	it('targets the remote database unless told otherwise', async () => {
		const { run, calls } = recording();
		await createWranglerQuery(run, false)('SELECT 1');
		await createWranglerQuery(run, true)('SELECT 1');

		expect(calls[0].file).toBe('wrangler');
		expect(calls[0].args.slice(0, 3)).toEqual(['d1', 'execute', 'numerai-cache']);
		expect(calls[0].args).toContain('--remote');
		expect(calls[0].args).toContain('--json');
		expect(calls[1].args).toContain('--local');
	});

	it('passes multi-line SQL with quotes through byte-for-byte, as one argument', async () => {
		// Regression: the SQL used to be JSON-quoted into a shell string, which sent
		// literal "\n" and "\t" to SQLite ("unrecognized token") for any multi-line
		// query. Found by an end-to-end precompute run.
		const sql = "WITH RECURSIVE\n\tup(n) AS (SELECT 1)\nSELECT name FROM t WHERE type = 'index' AND x = \"y\"";
		const { run, calls } = recording();
		await createWranglerQuery(run, false)(sql);

		const args = calls[0].args;
		expect(args[args.indexOf('--command') + 1]).toBe(sql);
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
