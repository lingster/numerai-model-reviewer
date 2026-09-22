/**
 * Configuration must fail loudly at startup rather than silently running with a
 * value nobody intended: parseInt accepts a numeric prefix, so "8787x" becomes
 * 8787 and a negative rate limit makes every request exceed the limit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const original = { ...process.env };
afterEach(() => {
	process.env = { ...original };
});

describe('loadConfig', () => {
	it('rejects a value with trailing characters instead of truncating it', () => {
		process.env.PORT = '8787x';
		expect(() => loadConfig()).toThrow(/PORT/);
	});

	it('rejects a non-numeric value', () => {
		process.env.PORT = 'eight';
		expect(() => loadConfig()).toThrow(/PORT/);
	});

	it('rejects a negative rate limit, which would block every request', () => {
		process.env.RATE_LIMIT_REQUESTS = '-1';
		expect(() => loadConfig()).toThrow(/RATE_LIMIT_REQUESTS/);
	});

	it('rejects a zero rate-limit window', () => {
		process.env.RATE_LIMIT_WINDOW_SECONDS = '0';
		expect(() => loadConfig()).toThrow(/RATE_LIMIT_WINDOW_SECONDS/);
	});

	it('allows port 0, which asks the OS for a free port', () => {
		process.env.PORT = '0';
		expect(loadConfig().port).toBe(0);
	});

	it('takes the defaults when nothing is set', () => {
		delete process.env.PORT;
		delete process.env.RATE_LIMIT_REQUESTS;
		const config = loadConfig();
		expect(config.port).toBe(8787);
		expect(config.rateLimitRequests).toBe(100);
	});
});
