/**
 * Starting the server for real: schema and migrations applied to a fresh file,
 * the worker's handler wired to it, and requests served.
 *
 * This is the test that would have caught the two things that actually broke
 * when the bridge was first run — the worker's default export being nested one
 * level deeper under CJS interop, and a fresh database missing the round index
 * because that lives in migrations rather than schema.sql.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './server.js';
import type { ServerConfig } from './config.js';

const ORIGIN = 'http://localhost:5173';

let directory: string;
let close: () => Promise<void>;
let baseUrl: string;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'numerai-api-'));
	const config: ServerConfig = {
		host: '127.0.0.1',
		port: 0, // any free port
		databasePath: join(directory, 'test.sqlite'),
		schemaPath: resolve('../worker/src/schema.sql'),
		migrationsPath: resolve('../worker/migrations'),
		applySchema: true,
		numeraiApiUrl: 'https://api-tournament.numer.ai/graphql',
		numeraiPublicKey: '',
		numeraiSecretKey: '',
		allowedOrigins: ORIGIN,
		allowedOriginSuffixes: '',
		rateLimitRequests: 1000,
		rateLimitWindowSeconds: 60
	};

	const api = createApiServer(config);
	close = api.close;
	await new Promise<void>((ready) => api.server.listen(0, '127.0.0.1', ready));
	baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
	await close?.();
	rmSync(directory, { recursive: true, force: true });
});

const get = (path: string, origin = ORIGIN) => fetch(`${baseUrl}${path}`, { headers: { Origin: origin } });

describe('a freshly started server', () => {
	it('serves health', async () => {
		const response = await get('/health');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
	});

	it('answers cache-status from an empty database rather than erroring', async () => {
		// Needs the round index, which only exists if migrations were applied too.
		const response = await get('/rankings/cache-status?tournament=8');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			tournament: 8,
			latestRound: null,
			earliestRound: null
		});
	});

	it('enforces the same CORS allowlist as the worker', async () => {
		expect((await get('/rankings/cache-status?tournament=8', 'https://not-allowed.example')).status).toBe(403);
	});

	it('leaves health open to any origin, as the worker deliberately does', async () => {
		// index.ts exempts /health from the allowlist so uptime checks work.
		expect((await get('/health', 'https://not-allowed.example')).status).toBe(200);
	});

	it('answers CORS preflight', async () => {
		const response = await fetch(`${baseUrl}/health`, {
			method: 'OPTIONS',
			headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' }
		});
		expect([200, 204]).toContain(response.status);
	});

	it('404s an unknown route', async () => {
		expect((await get('/no-such-route')).status).toBe(404);
	});

	it('validates parameters the way the worker does', async () => {
		expect((await get('/rankings/model-rank?startRound=1&endRound=2')).status).toBe(400);
	});
});
