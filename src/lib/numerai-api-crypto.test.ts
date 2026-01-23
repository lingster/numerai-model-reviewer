/**
 * Unit tests for NumeraiAPI - Crypto Tournament (Tournament ID: 12)
 * Tests user search, model search, and model lookup functionality
 * specifically for the Crypto Signals tournament.
 *
 * These tests make real API calls to the Numerai GraphQL API.
 */
import { describe, it, expect } from 'vitest';

// Direct API URL for testing (bypasses the proxy)
const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

// Crypto Tournament ID
const CRYPTO_TOURNAMENT_ID = 12;

/**
 * Helper function to make GraphQL queries directly to Numerai API
 */
async function query<T>(graphqlQuery: string, variables?: Record<string, unknown>): Promise<T> {
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

	const result = await response.json();

	if (result.errors && result.errors.length > 0) {
		throw new Error(result.errors.map((e: { message: string }) => e.message).join(', '));
	}

	return result.data;
}

describe('NumeraiAPI - Crypto Tournament - User Search', () => {
	it('should find user "fish_n_chips" when searching for "fish" in leaderboard', async () => {
		const searchTerm = 'fish';
		const targetUsername = 'fish_n_chips';
		const batchSize = 500;
		const maxUsers = 5000;
		let offset = 0;
		const matches: Array<{ id: string; username: string }> = [];

		// Search through the leaderboard for users containing "fish"
		while (offset < maxUsers) {
			const result = await query<{
				accountLeaderboard: Array<{ id: string; username: string }>;
			}>(
				`query leaderboardSearch($limit: Int!, $offset: Int!, $tournament: Int!) {
					accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
						id
						username
					}
				}`,
				{ limit: batchSize, offset, tournament: CRYPTO_TOURNAMENT_ID }
			);

			const batch = result.accountLeaderboard;
			if (batch.length === 0) {
				break;
			}

			for (const entry of batch) {
				if (entry.username.toLowerCase().includes(searchTerm)) {
					matches.push(entry);
				}
			}

			// If we found our target, we can stop early
			if (matches.some((user) => user.username.toLowerCase() === targetUsername)) {
				break;
			}

			if (batch.length < batchSize) {
				break;
			}

			offset += batchSize;
		}

		expect(Array.isArray(matches)).toBe(true);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((user) => user.username.toLowerCase() === targetUsername)).toBe(true);
	}, 60000);

	it('should find user "fish_n_chips" via accountProfile exact match', async () => {
		const result = await query<{
			accountProfile: { id: string; username: string } | null;
		}>(
			`query searchUser($username: String!) {
				accountProfile(username: $username) {
					id
					username
				}
			}`,
			{ username: 'fish_n_chips' }
		);

		expect(result.accountProfile).toBeDefined();
		expect(result.accountProfile?.username).toBe('fish_n_chips');
		expect(result.accountProfile?.id).toBeDefined();
	}, 30000);
});

describe('NumeraiAPI - Crypto Tournament - Model Search with Username Filter', () => {
	it('should return Crypto tournament models for user "fish_n_chips" including "fncc_t1"', async () => {
		// Note: accountProfile requires tournament parameter to return tournament-specific models
		const result = await query<{
			accountProfile: {
				id: string;
				username: string;
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					id
					username
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(result.accountProfile).toBeDefined();
		expect(result.accountProfile?.username).toBe('fish_n_chips');
		expect(result.accountProfile?.models).toBeDefined();
		expect(Array.isArray(result.accountProfile?.models)).toBe(true);

		// All models returned should be Crypto tournament models
		const cryptoModels = result.accountProfile?.models;

		expect(cryptoModels).toBeDefined();
		expect(cryptoModels!.length).toBeGreaterThan(0);

		// Check that fncc_t1 is in the Crypto models
		const fnccT1Model = cryptoModels?.find((model) => model.displayName === 'fncc_t1');

		expect(fnccT1Model).toBeDefined();
		expect(fnccT1Model?.displayName).toBe('fncc_t1');
		expect(fnccT1Model?.tournament).toBe(CRYPTO_TOURNAMENT_ID);
	}, 30000);

	it('should return multiple Crypto models for user "fish_n_chips"', async () => {
		const result = await query<{
			accountProfile: {
				models: Array<{ displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(result.accountProfile?.models).toBeDefined();

		const cryptoModels = result.accountProfile?.models;

		// Should have multiple crypto models (fncc_t1, fncc_t2, etc.)
		expect(cryptoModels!.length).toBeGreaterThanOrEqual(2);

		// All crypto models should start with fncc_
		const allFncc = cryptoModels?.every((model) =>
			model.displayName.toLowerCase().startsWith('fncc_')
		);
		expect(allFncc).toBe(true);

		// All models should be tournament 12
		const allCrypto = cryptoModels?.every((model) => model.tournament === CRYPTO_TOURNAMENT_ID);
		expect(allCrypto).toBe(true);
	}, 30000);
});

describe('NumeraiAPI - Crypto Tournament - Direct Model Search', () => {
	it('should find model "fncc_t1" in user models and verify it is a Crypto model', async () => {
		// Note: v3UserProfile doesn't work for Crypto models, use accountProfile with tournament filter
		const result = await query<{
			accountProfile: {
				username: string;
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					username
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(result.accountProfile).toBeDefined();
		expect(result.accountProfile?.username).toBe('fish_n_chips');

		// Find fncc_t1 model
		const fnccT1 = result.accountProfile?.models.find((m) => m.displayName === 'fncc_t1');

		expect(fnccT1).toBeDefined();
		expect(fnccT1?.displayName).toBe('fncc_t1');
		expect(fnccT1?.tournament).toBe(CRYPTO_TOURNAMENT_ID);
		expect(fnccT1?.id).toBeDefined();
	}, 30000);

	it('should find model "fncc_t2" in user models and verify it is a Crypto model', async () => {
		const result = await query<{
			accountProfile: {
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(result.accountProfile?.models).toBeDefined();

		// Find fncc_t2 model
		const fnccT2 = result.accountProfile?.models.find((m) => m.displayName === 'fncc_t2');

		expect(fnccT2).toBeDefined();
		expect(fnccT2?.displayName).toBe('fncc_t2');
		expect(fnccT2?.tournament).toBe(CRYPTO_TOURNAMENT_ID);
	}, 30000);

	it('should find both "fncc_t1" and "fncc_t2" when searching models starting with "fncc"', async () => {
		// Get all Crypto models for fish_n_chips and filter by name prefix
		const result = await query<{
			accountProfile: {
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(result.accountProfile?.models).toBeDefined();

		// Filter models that start with "fncc" (case-insensitive)
		const fnccModels = result.accountProfile?.models.filter((model) =>
			model.displayName.toLowerCase().startsWith('fncc')
		);

		expect(fnccModels).toBeDefined();
		expect(fnccModels!.length).toBeGreaterThanOrEqual(2);

		// Verify fncc_t1 is in the results
		const fnccT1 = fnccModels?.find((m) => m.displayName === 'fncc_t1');
		expect(fnccT1).toBeDefined();
		expect(fnccT1?.tournament).toBe(CRYPTO_TOURNAMENT_ID);

		// Verify fncc_t2 is in the results
		const fnccT2 = fnccModels?.find((m) => m.displayName === 'fncc_t2');
		expect(fnccT2).toBeDefined();
		expect(fnccT2?.tournament).toBe(CRYPTO_TOURNAMENT_ID);
	}, 30000);

	it('should verify all Crypto models for fish_n_chips start with "fncc"', async () => {
		const result = await query<{
			accountProfile: {
				models: Array<{ displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		const cryptoModels = result.accountProfile?.models;

		expect(cryptoModels).toBeDefined();
		expect(cryptoModels!.length).toBeGreaterThan(0);

		// All crypto models should be in the Crypto tournament
		const allCrypto = cryptoModels?.every((model) => model.tournament === CRYPTO_TOURNAMENT_ID);
		expect(allCrypto).toBe(true);

		// All fish_n_chips crypto models should start with fncc_
		const allFncc = cryptoModels?.every((model) =>
			model.displayName.toLowerCase().startsWith('fncc_')
		);
		expect(allFncc).toBe(true);
	}, 30000);
});

describe('NumeraiAPI - Crypto Tournament - Model Performance', () => {
	// Known model ID for fncc_t1 (can be retrieved from accountProfile)
	const FNCC_T1_MODEL_ID = 'b27db79e-bafa-4a76-8a75-9f91168cd222';

	it('should return performance data for Crypto model "fncc_t1" using v2RoundModelPerformances', async () => {
		// Crypto models use v2RoundModelPerformances with modelId (UUID) and tournament parameter
		const result = await query<{
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
		}>(
			`query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
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
			}`,
			{ modelId: FNCC_T1_MODEL_ID, tournament: CRYPTO_TOURNAMENT_ID, lastNRounds: 50 }
		);

		expect(result.v2RoundModelPerformances).toBeDefined();
		expect(Array.isArray(result.v2RoundModelPerformances)).toBe(true);
		expect(result.v2RoundModelPerformances.length).toBeGreaterThan(0);

		// Find a resolved round for testing
		const resolvedRound = result.v2RoundModelPerformances.find((r) => r.roundResolved === true);

		expect(resolvedRound).toBeDefined();
		expect(resolvedRound?.roundNumber).toBeDefined();
		expect(typeof resolvedRound?.roundNumber).toBe('number');
		expect(resolvedRound?.submissionScores).toBeDefined();
		expect(Array.isArray(resolvedRound?.submissionScores)).toBe(true);

		// Verify submission scores have expected metrics
		const corrScore = resolvedRound?.submissionScores.find((s) => s.displayName === 'corr');
		const mmcScore = resolvedRound?.submissionScores.find((s) => s.displayName === 'mmc');

		expect(corrScore).toBeDefined();
		expect(mmcScore).toBeDefined();
		// Resolved rounds should have values
		expect(corrScore?.value).not.toBeNull();
		expect(mmcScore?.value).not.toBeNull();
	}, 30000);

	it('should verify round 1163 has expected performance metrics for fncc_t1', async () => {
		const result = await query<{
			v2RoundModelPerformances: Array<{
				roundNumber: number;
				roundResolved: boolean | null;
				submissionScores: Array<{
					displayName: string;
					value: number | null;
				}>;
			}>;
		}>(
			`query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundResolved
					submissionScores {
						displayName
						value
					}
				}
			}`,
			{ modelId: FNCC_T1_MODEL_ID, tournament: CRYPTO_TOURNAMENT_ID, lastNRounds: 50 }
		);

		// Find round 1163
		const round1163 = result.v2RoundModelPerformances.find((r) => r.roundNumber === 1163);

		expect(round1163).toBeDefined();
		expect(round1163?.roundResolved).toBe(true);

		// Get corr and mmc values
		const corrScore = round1163?.submissionScores.find((s) => s.displayName === 'corr');
		const mmcScore = round1163?.submissionScores.find((s) => s.displayName === 'mmc');

		expect(corrScore).toBeDefined();
		expect(mmcScore).toBeDefined();

		// Verify approximate values for round 1163
		// corr: -0.166, mmc: -0.113 (based on actual API data)
		if (corrScore?.value !== null) {
			expect(corrScore.value).toBeCloseTo(-0.166, 1);
		}
		if (mmcScore?.value !== null) {
			expect(mmcScore.value).toBeCloseTo(-0.113, 1);
		}
	}, 30000);

	it('should retrieve model ID from accountProfile and use it for performance query', async () => {
		// First get the model ID from accountProfile
		const profileResult = await query<{
			accountProfile: {
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!, $tournament: Int!) {
				accountProfile(username: $username, tournament: $tournament) {
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips', tournament: CRYPTO_TOURNAMENT_ID }
		);

		expect(profileResult.accountProfile?.models).toBeDefined();

		const fnccT1 = profileResult.accountProfile?.models.find((m) => m.displayName === 'fncc_t1');
		expect(fnccT1).toBeDefined();
		expect(fnccT1?.id).toBe(FNCC_T1_MODEL_ID);

		// Now use that ID to get performance data
		const perfResult = await query<{
			v2RoundModelPerformances: Array<{
				roundNumber: number;
				roundResolved: boolean | null;
			}>;
		}>(
			`query getModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
				v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
					roundNumber
					roundResolved
				}
			}`,
			{ modelId: fnccT1!.id, tournament: CRYPTO_TOURNAMENT_ID, lastNRounds: 10 }
		);

		expect(perfResult.v2RoundModelPerformances).toBeDefined();
		expect(perfResult.v2RoundModelPerformances.length).toBeGreaterThan(0);
	}, 30000);
});
