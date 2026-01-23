/**
 * Unit tests for NumeraiAPI via Worker Proxy - Crypto Tournament (Tournament ID: 12)
 *
 * These tests verify that the worker proxy returns the same results as direct API calls.
 * They use wrangler's unstable_dev to spin up a local worker instance for testing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev, type UnstableDevWorker } from 'wrangler';

// Crypto Tournament ID
const CRYPTO_TOURNAMENT_ID = 12;

// Worker instance for testing
let worker: UnstableDevWorker;

// Test origin that matches ALLOWED_ORIGINS in wrangler.toml
const TEST_ORIGIN = 'http://localhost:5173';

/**
 * Helper function to make GraphQL queries to the worker proxy
 */
async function queryWorker<T>(
	graphqlQuery: string,
	variables?: Record<string, unknown>
): Promise<T> {
	const response = await worker.fetch('/graphql', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Origin: TEST_ORIGIN
		},
		body: JSON.stringify({
			query: graphqlQuery,
			variables
		})
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Worker request failed: ${response.status} ${response.statusText} - ${errorBody}`);
	}

	const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

	if (result.errors && result.errors.length > 0) {
		throw new Error(result.errors.map((e) => e.message).join(', '));
	}

	return result.data as T;
}

/**
 * Helper function to make GraphQL queries directly to Numerai API (for comparison)
 */
async function queryDirect<T>(
	graphqlQuery: string,
	variables?: Record<string, unknown>
): Promise<T> {
	const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

	const response = await fetch(NUMERAI_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			query: graphqlQuery,
			variables
		})
	});

	if (!response.ok) {
		throw new Error(`API request failed: ${response.status} ${response.statusText}`);
	}

	const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

	if (result.errors && result.errors.length > 0) {
		throw new Error(result.errors.map((e) => e.message).join(', '));
	}

	return result.data as T;
}

describe('NumeraiAPI Worker Proxy - Crypto Tournament Tests', () => {
	beforeAll(async () => {
		// Start the worker in dev mode
		worker = await unstable_dev('worker/src/index.ts', {
			experimental: { disableExperimentalWarning: true },
			vars: {
				ALLOWED_ORIGINS: TEST_ORIGIN,
				RATE_LIMIT_REQUESTS: '1000',
				RATE_LIMIT_WINDOW_SECONDS: '60',
				NUMERAI_API_URL: 'https://api-tournament.numer.ai/graphql'
			}
		});
	}, 30000);

	afterAll(async () => {
		if (worker) {
			await worker.stop();
		}
	});

	describe('Health Check', () => {
		it('should return healthy status from worker', async () => {
			const response = await worker.fetch('/health', {
				method: 'GET',
				headers: {
					Origin: TEST_ORIGIN
				}
			});

			expect(response.status).toBe(200);

			const data = (await response.json()) as { status: string; service: string };
			expect(data.status).toBe('ok');
			expect(data.service).toBe('numerai-api-proxy');
		}, 10000);
	});

	describe('CORS Handling', () => {
		it('should reject requests from non-allowed origins', async () => {
			const response = await worker.fetch('/graphql', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: 'https://malicious-site.com'
				},
				body: JSON.stringify({
					query: '{ __typename }'
				})
			});

			expect(response.status).toBe(403);
		}, 10000);

		it('should accept requests from allowed origins', async () => {
			const response = await worker.fetch('/graphql', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: TEST_ORIGIN
				},
				body: JSON.stringify({
					query: '{ __typename }'
				})
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);
		}, 10000);
	});

	describe('User Search via Worker', () => {
		it('should find user "fish_n_chips" via accountProfile through worker (matches direct API)', async () => {
			const query = `query searchUser($username: String!) {
				accountProfile(username: $username) {
					id
					username
				}
			}`;
			const variables = { username: 'fish_n_chips' };

			// Query through worker
			const workerResult = await queryWorker<{
				accountProfile: { id: string; username: string } | null;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				accountProfile: { id: string; username: string } | null;
			}>(query, variables);

			// Verify worker returns same data as direct API
			expect(workerResult.accountProfile).toBeDefined();
			expect(workerResult.accountProfile?.username).toBe('fish_n_chips');
			expect(workerResult.accountProfile?.id).toBeDefined();

			// Verify results match
			expect(workerResult.accountProfile?.id).toBe(directResult.accountProfile?.id);
			expect(workerResult.accountProfile?.username).toBe(directResult.accountProfile?.username);
		}, 30000);
	});

	describe('Model Search via Worker', () => {
		it('should return Crypto tournament models for user "fish_n_chips" including "fncc_t1" (matches direct API)', async () => {
			const query = `query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					id
					username
					models {
						id
						displayName
						tournament
					}
				}
			}`;
			const variables = { username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID };

			// Query through worker
			const workerResult = await queryWorker<{
				accountProfile: {
					id: string;
					username: string;
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				accountProfile: {
					id: string;
					username: string;
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			// Verify worker returns valid data
			expect(workerResult.accountProfile).toBeDefined();
			expect(workerResult.accountProfile?.username).toBe('fish_n_chips');
			expect(workerResult.accountProfile?.models).toBeDefined();
			expect(Array.isArray(workerResult.accountProfile?.models)).toBe(true);

			// All models should be Crypto tournament
			const cryptoModels = workerResult.accountProfile?.models;
			expect(cryptoModels).toBeDefined();
			expect(cryptoModels!.length).toBeGreaterThan(0);

			// Check fncc_t1 exists
			const fnccT1Model = cryptoModels?.find((model) => model.displayName === 'fncc_t1');
			expect(fnccT1Model).toBeDefined();
			expect(fnccT1Model?.tournament).toBe(CRYPTO_TOURNAMENT_ID);

			// Verify results match direct API
			expect(workerResult.accountProfile?.models.length).toBe(
				directResult.accountProfile?.models.length
			);

			// Verify fncc_t1 model ID matches
			const directFnccT1 = directResult.accountProfile?.models.find(
				(m) => m.displayName === 'fncc_t1'
			);
			expect(fnccT1Model?.id).toBe(directFnccT1?.id);
		}, 30000);

		it('should return multiple Crypto models for user "fish_n_chips" (matches direct API)', async () => {
			const query = `query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						displayName
						tournament
					}
				}
			}`;
			const variables = { username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID };

			// Query through worker
			const workerResult = await queryWorker<{
				accountProfile: {
					models: Array<{ displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				accountProfile: {
					models: Array<{ displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			expect(workerResult.accountProfile?.models).toBeDefined();

			const cryptoModels = workerResult.accountProfile?.models;

			// Should have multiple crypto models
			expect(cryptoModels!.length).toBeGreaterThanOrEqual(2);

			// All crypto models should start with fncc_
			const allFncc = cryptoModels?.every((model) =>
				model.displayName.toLowerCase().startsWith('fncc_')
			);
			expect(allFncc).toBe(true);

			// All models should be tournament 12
			const allCrypto = cryptoModels?.every((model) => model.tournament === CRYPTO_TOURNAMENT_ID);
			expect(allCrypto).toBe(true);

			// Verify count matches direct API
			expect(cryptoModels?.length).toBe(directResult.accountProfile?.models.length);
		}, 30000);
	});

	describe('Direct Model Search via Worker', () => {
		it('should find both "fncc_t1" and "fncc_t2" (matches direct API)', async () => {
			const query = `query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						id
						displayName
						tournament
					}
				}
			}`;
			const variables = { username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID };

			// Query through worker
			const workerResult = await queryWorker<{
				accountProfile: {
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				accountProfile: {
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(query, variables);

			expect(workerResult.accountProfile?.models).toBeDefined();

			// Filter models that start with "fncc"
			const fnccModels = workerResult.accountProfile?.models.filter((model) =>
				model.displayName.toLowerCase().startsWith('fncc')
			);

			expect(fnccModels).toBeDefined();
			expect(fnccModels!.length).toBeGreaterThanOrEqual(2);

			// Verify fncc_t1 exists
			const fnccT1 = fnccModels?.find((m) => m.displayName === 'fncc_t1');
			expect(fnccT1).toBeDefined();
			expect(fnccT1?.tournament).toBe(CRYPTO_TOURNAMENT_ID);

			// Verify fncc_t2 exists
			const fnccT2 = fnccModels?.find((m) => m.displayName === 'fncc_t2');
			expect(fnccT2).toBeDefined();
			expect(fnccT2?.tournament).toBe(CRYPTO_TOURNAMENT_ID);

			// Verify IDs match direct API
			const directFnccT1 = directResult.accountProfile?.models.find(
				(m) => m.displayName === 'fncc_t1'
			);
			const directFnccT2 = directResult.accountProfile?.models.find(
				(m) => m.displayName === 'fncc_t2'
			);

			expect(fnccT1?.id).toBe(directFnccT1?.id);
			expect(fnccT2?.id).toBe(directFnccT2?.id);
		}, 30000);
	});

	describe('Model Performance via Worker', () => {
		// Known model ID for fncc_t1
		const FNCC_T1_MODEL_ID = 'b27db79e-bafa-4a76-8a75-9f91168cd222';

		it('should return performance data for Crypto model "fncc_t1" (matches direct API)', async () => {
			const query = `query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundOpenTime
					roundResolveTime
					roundResolved
					submissionScores {
						displayName
						value
					}
				}
			}`;
			const variables = {
				modelId: FNCC_T1_MODEL_ID,
				tournament: CRYPTO_TOURNAMENT_ID,
				lastNRounds: 50
			};

			// Query through worker
			const workerResult = await queryWorker<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundOpenTime: string | null;
					roundResolveTime: string | null;
					roundResolved: boolean | null;
					submissionScores: Array<{
						displayName: string;
						value: number | null;
					}>;
				}>;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundOpenTime: string | null;
					roundResolveTime: string | null;
					roundResolved: boolean | null;
					submissionScores: Array<{
						displayName: string;
						value: number | null;
					}>;
				}>;
			}>(query, variables);

			// Verify worker returns valid data
			expect(workerResult.v2RoundModelPerformances).toBeDefined();
			expect(Array.isArray(workerResult.v2RoundModelPerformances)).toBe(true);
			expect(workerResult.v2RoundModelPerformances.length).toBeGreaterThan(0);

			// Find a resolved round
			const resolvedRound = workerResult.v2RoundModelPerformances.find(
				(r) => r.roundResolved === true
			);

			expect(resolvedRound).toBeDefined();
			expect(resolvedRound?.roundNumber).toBeDefined();
			expect(resolvedRound?.submissionScores).toBeDefined();

			// Verify scores have expected metrics
			const corrScore = resolvedRound?.submissionScores.find((s) => s.displayName === 'corr');
			const mmcScore = resolvedRound?.submissionScores.find((s) => s.displayName === 'mmc');

			expect(corrScore).toBeDefined();
			expect(mmcScore).toBeDefined();
			expect(corrScore?.value).not.toBeNull();
			expect(mmcScore?.value).not.toBeNull();

			// Verify results match direct API (same number of rounds)
			expect(workerResult.v2RoundModelPerformances.length).toBe(
				directResult.v2RoundModelPerformances.length
			);

			// Verify a specific round's data matches
			const workerRound = workerResult.v2RoundModelPerformances.find(
				(r) => r.roundNumber === resolvedRound?.roundNumber
			);
			const directRound = directResult.v2RoundModelPerformances.find(
				(r) => r.roundNumber === resolvedRound?.roundNumber
			);

			expect(workerRound?.roundResolved).toBe(directRound?.roundResolved);

			const workerCorr = workerRound?.submissionScores.find((s) => s.displayName === 'corr');
			const directCorr = directRound?.submissionScores.find((s) => s.displayName === 'corr');

			expect(workerCorr?.value).toBe(directCorr?.value);
		}, 30000);

		it('should return performance data for round 1163 with same values as direct API', async () => {
			const query = `query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundResolved
					submissionScores {
						displayName
						value
					}
				}
			}`;
			const variables = {
				modelId: FNCC_T1_MODEL_ID,
				tournament: CRYPTO_TOURNAMENT_ID,
				lastNRounds: 50
			};

			// Query through worker
			const workerResult = await queryWorker<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundResolved: boolean | null;
					submissionScores: Array<{
						displayName: string;
						value: number | null;
					}>;
				}>;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundResolved: boolean | null;
					submissionScores: Array<{
						displayName: string;
						value: number | null;
					}>;
				}>;
			}>(query, variables);

			// Find round 1163 in both results
			const workerRound1163 = workerResult.v2RoundModelPerformances.find(
				(r) => r.roundNumber === 1163
			);
			const directRound1163 = directResult.v2RoundModelPerformances.find(
				(r) => r.roundNumber === 1163
			);

			expect(workerRound1163).toBeDefined();
			expect(workerRound1163?.roundResolved).toBe(true);

			// Get corr and mmc values from worker
			const workerCorr = workerRound1163?.submissionScores.find((s) => s.displayName === 'corr');
			const workerMmc = workerRound1163?.submissionScores.find((s) => s.displayName === 'mmc');

			// Get corr and mmc values from direct API
			const directCorr = directRound1163?.submissionScores.find((s) => s.displayName === 'corr');
			const directMmc = directRound1163?.submissionScores.find((s) => s.displayName === 'mmc');

			// Verify worker returns same values as direct API
			expect(workerCorr?.value).toBe(directCorr?.value);
			expect(workerMmc?.value).toBe(directMmc?.value);

			// Also verify against expected values from original test
			if (workerCorr?.value !== null) {
				expect(workerCorr.value).toBeCloseTo(-0.166, 1);
			}
			if (workerMmc?.value !== null) {
				expect(workerMmc.value).toBeCloseTo(-0.113, 1);
			}
		}, 30000);

		it('should retrieve model ID from accountProfile and use it for performance query (same as direct)', async () => {
			// First get the model ID through worker
			const profileQuery = `query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						id
						displayName
						tournament
					}
				}
			}`;
			const profileVariables = { username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID };

			const workerProfileResult = await queryWorker<{
				accountProfile: {
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(profileQuery, profileVariables);

			const directProfileResult = await queryDirect<{
				accountProfile: {
					models: Array<{ id: string; displayName: string; tournament: number }>;
				} | null;
			}>(profileQuery, profileVariables);

			// Verify model IDs match
			const workerFnccT1 = workerProfileResult.accountProfile?.models.find(
				(m) => m.displayName === 'fncc_t1'
			);
			const directFnccT1 = directProfileResult.accountProfile?.models.find(
				(m) => m.displayName === 'fncc_t1'
			);

			expect(workerFnccT1).toBeDefined();
			expect(workerFnccT1?.id).toBe(directFnccT1?.id);
			expect(workerFnccT1?.id).toBe(FNCC_T1_MODEL_ID);

			// Now use that ID to get performance data through worker
			const perfQuery = `query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundResolved
				}
			}`;
			const perfVariables = {
				modelId: workerFnccT1!.id,
				tournament: CRYPTO_TOURNAMENT_ID,
				lastNRounds: 10
			};

			const workerPerfResult = await queryWorker<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundResolved: boolean | null;
				}>;
			}>(perfQuery, perfVariables);

			const directPerfResult = await queryDirect<{
				v2RoundModelPerformances: Array<{
					roundNumber: number;
					roundResolved: boolean | null;
				}>;
			}>(perfQuery, perfVariables);

			// Verify performance data returned
			expect(workerPerfResult.v2RoundModelPerformances).toBeDefined();
			expect(workerPerfResult.v2RoundModelPerformances.length).toBeGreaterThan(0);

			// Verify matches direct API
			expect(workerPerfResult.v2RoundModelPerformances.length).toBe(
				directPerfResult.v2RoundModelPerformances.length
			);

			// Verify round numbers match
			const workerRounds = workerPerfResult.v2RoundModelPerformances
				.map((r) => r.roundNumber)
				.sort();
			const directRounds = directPerfResult.v2RoundModelPerformances
				.map((r) => r.roundNumber)
				.sort();

			expect(workerRounds).toEqual(directRounds);
		}, 45000);
	});

	describe('Leaderboard Search via Worker', () => {
		it('should search accountLeaderboard for Crypto tournament (matches direct API)', async () => {
			const query = `query leaderboardSearch($limit: Int!, $offset: Int!, $tournament: Int!) {
				accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
					id
					username
				}
			}`;
			const variables = { limit: 100, offset: 0, tournament: CRYPTO_TOURNAMENT_ID };

			// Query through worker
			const workerResult = await queryWorker<{
				accountLeaderboard: Array<{ id: string; username: string }>;
			}>(query, variables);

			// Query directly for comparison
			const directResult = await queryDirect<{
				accountLeaderboard: Array<{ id: string; username: string }>;
			}>(query, variables);

			// Verify worker returns valid data
			expect(workerResult.accountLeaderboard).toBeDefined();
			expect(Array.isArray(workerResult.accountLeaderboard)).toBe(true);
			expect(workerResult.accountLeaderboard.length).toBeGreaterThan(0);

			// Verify count matches direct API
			expect(workerResult.accountLeaderboard.length).toBe(directResult.accountLeaderboard.length);

			// Verify first few entries match (leaderboard order might vary slightly)
			const workerUsernames = new Set(workerResult.accountLeaderboard.map((u) => u.username));
			const directUsernames = new Set(directResult.accountLeaderboard.map((u) => u.username));

			// Should have significant overlap (at least 90% of usernames should match)
			const intersection = [...workerUsernames].filter((u) => directUsernames.has(u));
			expect(intersection.length).toBeGreaterThanOrEqual(
				Math.floor(workerResult.accountLeaderboard.length * 0.9)
			);
		}, 30000);
	});
});
