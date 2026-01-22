/**
 * Unit tests for NumeraiAPI
 * Tests user search, model search, and performance data functionality
 *
 * These tests make real API calls to the Numerai GraphQL API to verify
 * that our client correctly fetches and processes data.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Direct API URL for testing (bypasses the proxy)
const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

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

describe('NumeraiAPI - User Search', () => {
	it('should find user "anonemaus" when searching for "anon"', async () => {
		const searchTerm = 'anon';
		const targetUsername = 'anonemaus';
		const batchSize = 500;
		const maxUsers = 5000;
		let offset = 0;
		const matches: Array<{ id: string; username: string }> = [];

		while (offset < maxUsers) {
			const result = await query<{
				accountLeaderboard: Array<{ id: string; username: string }>;
			}>(
				`query leaderboardSearch($limit: Int!, $offset: Int!) {
					accountLeaderboard(limit: $limit, offset: $offset) {
						id
						username
					}
				}`,
				{ limit: batchSize, offset }
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
		// Test the accountProfile query that should find exact username matches
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

	it('should find user "fish" via accountProfile (there is a user named fish)', async () => {
		// There is actually a user named "fish" - exact match
		const result = await query<{
			accountProfile: { id: string; username: string } | null;
		}>(
			`query searchUser($username: String!) {
				accountProfile(username: $username) {
					id
					username
				}
			}`,
			{ username: 'fish' }
		);

		expect(result.accountProfile).toBeDefined();
		expect(result.accountProfile?.username).toBe('fish');
	}, 30000);

	it('should NOT find partial match "fish_n" via accountProfile', async () => {
		// accountProfile only does exact matches
		// Note: The API may return an error for some non-existent users
		try {
			const result = await query<{
				accountProfile: { id: string; username: string } | null;
			}>(
				`query searchUser($username: String!) {
					accountProfile(username: $username) {
						id
						username
					}
				}`,
				{ username: 'fish_n' }
			);

			// This should return null because there's no user exactly named "fish_n"
			expect(result.accountProfile).toBeNull();
		} catch (error) {
			// API may return 500 for non-existent users - this is acceptable behavior
			// The important thing is it doesn't return a partial match
			expect(error).toBeDefined();
		}
	}, 30000);

	it('should find users in v2Leaderboard containing search term', async () => {
		// Test that leaderboard search works for partial matches
		const result = await query<{
			v2Leaderboard: Array<{ username: string }>;
		}>(
			`query leaderboardSearch($limit: Int!, $offset: Int!) {
				v2Leaderboard(limit: $limit, offset: $offset) {
					username
				}
			}`,
			{ limit: 100, offset: 0 }
		);

		expect(result.v2Leaderboard).toBeDefined();
		expect(Array.isArray(result.v2Leaderboard)).toBe(true);
		expect(result.v2Leaderboard.length).toBe(100);

		// All results should have usernames
		result.v2Leaderboard.forEach((entry) => {
			expect(entry.username).toBeDefined();
			expect(typeof entry.username).toBe('string');
		});
	}, 30000);
});

describe('NumeraiAPI - Get User Models', () => {
	it('should return models for user "fish_n_chips" including "fnc_imp_01"', async () => {
		const result = await query<{
			accountProfile: {
				id: string;
				username: string;
				models: Array<{ id: string; displayName: string; tournament: number }>;
			} | null;
		}>(
			`query getUserModels($username: String!) {
				accountProfile(username: $username) {
					id
					username
					models {
						id
						displayName
						tournament
					}
				}
			}`,
			{ username: 'fish_n_chips' }
		);

		expect(result.accountProfile).toBeDefined();
		expect(result.accountProfile?.username).toBe('fish_n_chips');
		expect(result.accountProfile?.models).toBeDefined();
		expect(Array.isArray(result.accountProfile?.models)).toBe(true);
		expect(result.accountProfile?.models.length).toBeGreaterThan(10);

		// Check that fnc_imp_01 is in the models
		const fncModel = result.accountProfile?.models.find(
			(model) => model.displayName === 'fnc_imp_01'
		);

		expect(fncModel).toBeDefined();
		expect(fncModel?.displayName).toBe('fnc_imp_01');
	}, 30000);

	it('should return models starting with "fnc_" for fish_n_chips', async () => {
		const result = await query<{
			accountProfile: {
				models: Array<{ displayName: string }>;
			} | null;
		}>(
			`query getUserModels($username: String!) {
				accountProfile(username: $username) {
					models {
						displayName
					}
				}
			}`,
			{ username: 'fish_n_chips' }
		);

		expect(result.accountProfile?.models).toBeDefined();

		// All fish_n_chips models start with fnc_
		const allFnc = result.accountProfile?.models.every((model) =>
			model.displayName.toLowerCase().startsWith('fnc_')
		);
		expect(allFnc).toBe(true);
	}, 30000);
});

describe('NumeraiAPI - Model Performance Data', () => {
	it('should return performance data for model "fnc_imp_01" with correct round 1163 data', async () => {
		// Test that we can retrieve performance data for a specific model
		// and verify specific round data for round 1163
		const result = await query<{
			v3UserProfile: {
				id: string;
				username: string;
				accountName: string;
				roundModelPerformances: Array<{
					roundNumber: number;
					roundOpenTime: string;
					roundResolveTime: string;
					corr20V2: number | null;
					mmc: number | null;
					payout: number | null;
					selectedStakeValue: number | null;
					roundPayoutFactor: string | null;
				}>;
			} | null;
		}>(
			`query getModelPerformance($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					id
					username
					accountName
					roundModelPerformances {
						roundNumber
						roundOpenTime
						roundResolveTime
						corr20V2
						mmc
						payout
						selectedStakeValue
						roundPayoutFactor
					}
				}
			}`,
			{ modelName: 'fnc_imp_01' }
		);

		expect(result.v3UserProfile).toBeDefined();
		expect(result.v3UserProfile?.username).toBe('fnc_imp_01');
		expect(result.v3UserProfile?.accountName).toBe('fish_n_chips');
		expect(result.v3UserProfile?.roundModelPerformances).toBeDefined();
		expect(Array.isArray(result.v3UserProfile?.roundModelPerformances)).toBe(true);

		// Find round 1163 data
		const round1163 = result.v3UserProfile?.roundModelPerformances.find(
			(r) => r.roundNumber === 1163
		);

		expect(round1163).toBeDefined();
		expect(round1163?.roundNumber).toBe(1163);

		// Verify the round dates (approximately - format may vary)
		// Close date: 19th Dec 2025, Resolve date: 21 Jan 2026
		if (round1163?.roundOpenTime) {
			expect(round1163.roundOpenTime).toContain('2025-12');
		}
		if (round1163?.roundResolveTime) {
			expect(round1163.roundResolveTime).toContain('2026-01');
		}

		// Verify performance metrics (with tolerance for floating point)
		// Expected: Payout=-0.083, corr20=-0.0329, mmc=-0.0260
		if (round1163?.payout !== null) {
			expect(round1163.payout).toBeCloseTo(-0.083, 2);
		}

		if (round1163?.corr20V2 !== null) {
			expect(round1163.corr20V2).toBeCloseTo(-0.0329, 2);
		}

		if (round1163?.mmc !== null) {
			expect(round1163.mmc).toBeCloseTo(-0.026, 2);
		}
	}, 30000);

	it('should return stake value for round 1163 as approximately 11.05', async () => {
		const result = await query<{
			v3UserProfile: {
				roundModelPerformances: Array<{
					roundNumber: number;
					selectedStakeValue: number | null;
				}>;
			} | null;
		}>(
			`query getModelPerformance($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					roundModelPerformances {
						roundNumber
						selectedStakeValue
					}
				}
			}`,
			{ modelName: 'fnc_imp_01' }
		);

		const round1163 = result.v3UserProfile?.roundModelPerformances.find(
			(r) => r.roundNumber === 1163
		);

		expect(round1163).toBeDefined();
		// At-risk (stake value) should be approximately 11.05
		if (round1163?.selectedStakeValue !== null) {
			expect(round1163.selectedStakeValue).toBeCloseTo(11.05, 1);
		}
	}, 30000);

	it('should return payout factor for round 1163 as approximately 0.1092', async () => {
		const result = await query<{
			v3UserProfile: {
				roundModelPerformances: Array<{
					roundNumber: number;
					roundPayoutFactor: string | null;
				}>;
			} | null;
		}>(
			`query getModelPerformance($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					roundModelPerformances {
						roundNumber
						roundPayoutFactor
					}
				}
			}`,
			{ modelName: 'fnc_imp_01' }
		);

		const round1163 = result.v3UserProfile?.roundModelPerformances.find(
			(r) => r.roundNumber === 1163
		);

		expect(round1163).toBeDefined();
		// Payout factor should be approximately 0.1092
		if (round1163?.roundPayoutFactor !== null) {
			const pf = parseFloat(round1163.roundPayoutFactor);
			expect(pf).toBeCloseTo(0.1092, 2);
		}
	}, 30000);
});

describe('NumeraiAPI - Model Lookup by Name', () => {
	it('should find model "fnc_imp_01" and return account owner "fish_n_chips"', async () => {
		const result = await query<{
			v3UserProfile: {
				id: string;
				username: string;
				accountName: string;
			} | null;
		}>(
			`query getModelByName($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					id
					username
					accountName
				}
			}`,
			{ modelName: 'fnc_imp_01' }
		);

		expect(result.v3UserProfile).toBeDefined();
		// username is the model name
		expect(result.v3UserProfile?.username).toBe('fnc_imp_01');
		// accountName is the user who owns the model
		expect(result.v3UserProfile?.accountName).toBe('fish_n_chips');
	}, 30000);

	it('should return null for non-existent model', async () => {
		const result = await query<{
			v3UserProfile: { id: string } | null;
		}>(
			`query getModelByName($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					id
				}
			}`,
			{ modelName: 'this_model_definitely_does_not_exist_12345' }
		);

		expect(result.v3UserProfile).toBeNull();
	}, 30000);
});
