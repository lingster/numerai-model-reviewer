import { describe, it, expect } from 'vitest';
import { d1Retry } from './d1-retry';

describe('d1Retry', () => {
	it('returns the result when the operation succeeds first try', async () => {
		let calls = 0;
		const result = await d1Retry(async () => {
			calls++;
			return 'ok';
		});
		expect(result).toBe('ok');
		expect(calls).toBe(1);
	});

	it('retries a transient "database is locked" error, then succeeds', async () => {
		let calls = 0;
		const result = await d1Retry(async () => {
			calls++;
			if (calls < 3) throw new Error('SQLite failed; database is locked: SQLITE_BUSY');
			return 42;
		});
		expect(result).toBe(42);
		expect(calls).toBe(3);
	});

	it('does not retry a non-transient error', async () => {
		let calls = 0;
		await expect(
			d1Retry(async () => {
				calls++;
				throw new Error('no such table: model_performances');
			})
		).rejects.toThrow('no such table');
		expect(calls).toBe(1);
	});

	it('gives up and rethrows after exhausting attempts', async () => {
		let calls = 0;
		await expect(
			d1Retry(async () => {
				calls++;
				throw new Error('SQLITE_BUSY: database is locked');
			}, 3)
		).rejects.toThrow('SQLITE_BUSY');
		expect(calls).toBe(3);
	});
});
