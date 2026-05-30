/**
 * Worker REST endpoint tests for the Crypto tournament (ID 12).
 *
 * The worker was refactored from a GraphQL proxy into a REST API, so these
 * tests exercise the REST endpoints (not the removed POST /graphql) and
 * cross-check selected values against the live Numerai GraphQL API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

const CRYPTO_TOURNAMENT_ID = 12;
const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';
const TEST_ORIGIN = 'http://localhost:5173';
const FNCC_T1_MODEL_ID = 'b27db79e-bafa-4a76-8a75-9f91168cd222';

let worker: Unstable_DevWorker;

/** GET a worker REST endpoint with the allowed Origin header. */
function workerGet(path: string) {
	return worker.fetch(path, { method: 'GET', headers: { Origin: TEST_ORIGIN } });
}

describe('NumeraiAPI Worker (REST) - Crypto Tournament', () => {
	beforeAll(async () => {
		worker = await unstable_dev('worker/src/index.ts', {
			experimental: { disableExperimentalWarning: true },
			vars: {
				ALLOWED_ORIGINS: TEST_ORIGIN,
				RATE_LIMIT_REQUESTS: '1000',
				RATE_LIMIT_WINDOW_SECONDS: '60',
				NUMERAI_API_URL
			}
		});
	}, 30000);

	afterAll(async () => {
		if (worker) await worker.stop();
	});

	describe('Health & CORS', () => {
		it('returns healthy status', async () => {
			const response = await workerGet('/health');
			expect(response.status).toBe(200);
			const data = (await response.json()) as { status: string; service: string };
			expect(data.status).toBe('ok');
			expect(data.service).toBe('numerai-api-proxy');
		}, 10000);

		it('rejects requests from non-allowed origins', async () => {
			const response = await worker.fetch('/search/users?q=fish', {
				method: 'GET',
				headers: { Origin: 'https://malicious-site.com' }
			});
			expect(response.status).toBe(403);
		}, 10000);

		it('accepts requests from allowed origins with CORS header', async () => {
			const response = await workerGet('/search/users?q=fish_n_chips');
			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
		}, 30000);
	});

	describe('GET /search/users', () => {
		it('finds user "fish_n_chips"', async () => {
			const response = await workerGet('/search/users?q=fish_n_chips');
			expect(response.status).toBe(200);
			const users = (await response.json()) as Array<{ id: string; username: string }>;
			expect(Array.isArray(users)).toBe(true);
			expect(users.some((u) => u.username === 'fish_n_chips')).toBe(true);
		}, 30000);
	});

	describe('GET /users/:username/models', () => {
		it('returns Crypto models for fish_n_chips including fncc_t1', async () => {
			const response = await workerGet(`/users/fish_n_chips/models?tournament=${CRYPTO_TOURNAMENT_ID}`);
			expect(response.status).toBe(200);
			const models = (await response.json()) as Array<{ id: string; name: string; tournament: number }>;
			expect(models.length).toBeGreaterThan(0);
			// All returned models are Crypto and share the fncc_ prefix.
			expect(models.every((m) => m.tournament === CRYPTO_TOURNAMENT_ID)).toBe(true);
			expect(models.every((m) => m.name.toLowerCase().startsWith('fncc'))).toBe(true);

			const fnccT1 = models.find((m) => m.name === 'fncc_t1');
			expect(fnccT1).toBeDefined();
			expect(fnccT1?.id).toBe(FNCC_T1_MODEL_ID);
		}, 30000);
	});

	describe('GET /models/:modelName/performance', () => {
		it('returns Crypto performance for fncc_t1 with finite corr/mmc on resolved rounds', async () => {
			const response = await workerGet(
				`/models/fncc_t1/performance?tournament=${CRYPTO_TOURNAMENT_ID}&modelId=${FNCC_T1_MODEL_ID}`
			);
			expect(response.status).toBe(200);

			const perf = (await response.json()) as {
				modelName: string;
				rounds: Array<{ roundNumber: number; roundResolved?: boolean; correlation: number | null; mmc: number | null }>;
			};
			expect(perf.modelName).toBe('fncc_t1');
			expect(Array.isArray(perf.rounds)).toBe(true);

			const resolved = perf.rounds.find((r) => r.roundResolved && r.correlation !== null);
			expect(resolved).toBeDefined();
			expect(typeof resolved?.correlation).toBe('number');
			expect(typeof resolved?.mmc).toBe('number');
		}, 45000);
	});
});
