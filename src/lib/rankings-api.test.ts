/**
 * Unit and integration tests for Rankings API
 *
 * Tests:
 * 1. calculateCustomScore - pure unit tests
 * 2. Numerai API direct - verify raw model performance data
 * 3. Worker /rankings/model-rank - verify rank, totalModels, corr, mmc
 *
 * Expected data for model "fnc_dl2_994b" (tournament 8, default formula 0.75*corr + 2.25*mmc):
 * Rankings use roundDetails API (v2Corr20 metric) for staked models:
 *   Round 1170: rank=6, corr=0.0433, mmc=0.0371, totalModels=4046
 *   Round 1171: rank=7, corr=0.0402, mmc=0.0356, totalModels=4093
 */
import { describe, it, expect } from 'vitest';
import { calculateCustomScore, DEFAULT_SCORE_FORMULA } from './rankings-api.js';
import type { ScoreFormula } from './types.js';

// Worker API URL for integration tests
const WORKER_API_URL = 'http://localhost:8787';

// Numerai API URL for direct data verification
const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

// Test constants
const MODEL_NAME = 'fnc_dl2_994b';
const TOURNAMENT = 8;
const START_ROUND = 1170;
const END_ROUND = 1171;

// Expected values per round (ranks computed with 0.75*v2Corr20 + 2.25*mmc among staked models)
const EXPECTED = {
	1170: {
		rank: 6,
		corr: 0.0433,
		mmc: 0.0371,
		totalModels: 4046
	},
	1171: {
		rank: 7,
		corr: 0.0402,
		mmc: 0.0356,
		totalModels: 4093
	}
} as const;

/**
 * Helper to query the Numerai GraphQL API directly
 */
async function queryNumerai<T>(graphqlQuery: string, variables?: Record<string, unknown>): Promise<T> {
	const response = await fetch(NUMERAI_API_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: graphqlQuery, variables })
	});

	if (!response.ok) {
		throw new Error(`API request failed: ${response.status} ${response.statusText}`);
	}

	const result = await response.json();

	if (result.errors?.length > 0) {
		throw new Error(result.errors.map((e: { message: string }) => e.message).join(', '));
	}

	return result.data;
}

// ─── Pure Unit Tests ─────────────────────────────────────────────────────────

describe('calculateCustomScore - unit tests', () => {
	it('should calculate score with default formula (0.75*corr + 2.25*mmc)', () => {
		const score = calculateCustomScore(0.0433, 0.0371, DEFAULT_SCORE_FORMULA);
		// 0.75 * 0.0433 + 2.25 * 0.0371 = 0.032475 + 0.083475 = 0.11595
		expect(score).toBeCloseTo(0.11595, 4);
	});

	it('should calculate score for round 1170 expected values', () => {
		const score = calculateCustomScore(
			EXPECTED[1170].corr,
			EXPECTED[1170].mmc,
			DEFAULT_SCORE_FORMULA
		);
		expect(score).toBeCloseTo(0.1160, 3);
	});

	it('should calculate score for round 1171 expected values', () => {
		const score = calculateCustomScore(
			EXPECTED[1171].corr,
			EXPECTED[1171].mmc,
			DEFAULT_SCORE_FORMULA
		);
		expect(score).toBeCloseTo(0.1103, 3);
	});

	it('should return null when all metrics are null', () => {
		const score = calculateCustomScore(null, null, DEFAULT_SCORE_FORMULA);
		expect(score).toBeNull();
	});

	it('should treat null values as 0 in calculations', () => {
		const score = calculateCustomScore(0.05, null, DEFAULT_SCORE_FORMULA);
		// 0.75 * 0.05 + 2.25 * 0 = 0.0375
		expect(score).toBeCloseTo(0.0375, 4);
	});

	it('should handle custom formula weights', () => {
		const formula: ScoreFormula = { corrWeight: 1.0, mmcWeight: 1.0 };
		const score = calculateCustomScore(0.1, 0.2, formula);
		// 1.0 * 0.1 + 1.0 * 0.2 + 1.0 * 0.3 = 0.6
		expect(score).toBeCloseTo(0.6, 4);
	});

	it('should handle zero weights', () => {
		const formula: ScoreFormula = { corrWeight: 0, mmcWeight: 0 };
		const score = calculateCustomScore(0.1, 0.2, formula);
		expect(score).toBeCloseTo(0, 4);
	});

	it('should handle negative metric values', () => {
		const score = calculateCustomScore(-0.05, -0.03, DEFAULT_SCORE_FORMULA);
		// 0.75 * (-0.05) + 2.25 * (-0.03) = -0.0375 + -0.0675 = -0.105
		expect(score).toBeCloseTo(-0.105, 4);
	});
});

// ─── Numerai API Direct Tests ────────────────────────────────────────────────

describe('Numerai API - fnc_dl2_994b model performance', () => {
	it('should return performance data for fnc_dl2_994b with correct round 1170 metrics', async () => {
		const result = await queryNumerai<{
			v3UserProfile: {
				id: string;
				username: string;
				accountName: string;
				roundModelPerformances: Array<{
					roundNumber: number;
					corr20V2: number | null;
					mmc: number | null;
					selectedStakeValue: number | null;
					roundResolved: boolean | null;
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
						corr20V2
						mmc
						selectedStakeValue
						roundResolved
					}
				}
			}`,
			{ modelName: MODEL_NAME }
		);

		expect(result.v3UserProfile).toBeDefined();
		expect(result.v3UserProfile?.username).toBe(MODEL_NAME);
		expect(result.v3UserProfile?.accountName).toBe('fish_n_chips');

		// Verify round 1170
		const round1170 = result.v3UserProfile?.roundModelPerformances.find(
			r => r.roundNumber === 1170
		);
		expect(round1170).toBeDefined();
		expect(round1170?.corr20V2).toBeCloseTo(EXPECTED[1170].corr, 3);
		expect(round1170?.mmc).toBeCloseTo(EXPECTED[1170].mmc, 3);

		// Verify round 1171
		const round1171 = result.v3UserProfile?.roundModelPerformances.find(
			r => r.roundNumber === 1171
		);
		expect(round1171).toBeDefined();
		expect(round1171?.corr20V2).toBeCloseTo(EXPECTED[1171].corr, 3);
		expect(round1171?.mmc).toBeCloseTo(EXPECTED[1171].mmc, 3);
	}, 30000);

	it('should confirm fnc_dl2_994b is owned by fish_n_chips', async () => {
		const result = await queryNumerai<{
			v3UserProfile: { username: string; accountName: string } | null;
		}>(
			`query getModel($modelName: String!) {
				v3UserProfile(modelName: $modelName) {
					username
					accountName
				}
			}`,
			{ modelName: MODEL_NAME }
		);

		expect(result.v3UserProfile?.username).toBe(MODEL_NAME);
		expect(result.v3UserProfile?.accountName).toBe('fish_n_chips');
	}, 30000);
});

// ─── Worker API Integration Tests ────────────────────────────────────────────

describe('Worker API - /rankings/model-rank endpoint', () => {
	const buildUrl = (params: Record<string, string | number>) => {
		const searchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			searchParams.set(key, String(value));
		}
		return `${WORKER_API_URL}/rankings/model-rank?${searchParams}`;
	};

	it('should return correct rank and totalModels for fnc_dl2_994b rounds 1170-1171', async () => {
		const url = buildUrl({
			modelName: MODEL_NAME,
			startRound: START_ROUND,
			endRound: END_ROUND,
			tournament: TOURNAMENT,
			corrWeight: DEFAULT_SCORE_FORMULA.corrWeight,
			mmcWeight: DEFAULT_SCORE_FORMULA.mmcWeight,
		});

		const response = await fetch(url, {
			headers: { Origin: 'http://localhost:5174' }
		});

		expect(response.ok).toBe(true);

		const data = await response.json() as {
			modelName: string;
			username: string;
			rounds: Array<{
				roundNumber: number;
				rank: number | null;
				corr: number | null;
				mmc: number | null;
				customScore: number | null;
				totalModels: number;
			}>;
		};

		expect(data.modelName).toBe(MODEL_NAME);

		// Find round 1170 - verify corr/mmc match numer.ai source of truth
		const round1170 = data.rounds.find(r => r.roundNumber === 1170);
		expect(round1170).toBeDefined();
		expect(round1170?.rank).toBe(EXPECTED[1170].rank);
		expect(round1170?.corr).toBeCloseTo(EXPECTED[1170].corr, 3);
		expect(round1170?.mmc).toBeCloseTo(EXPECTED[1170].mmc, 3);
		expect(round1170?.totalModels).toBe(EXPECTED[1170].totalModels);

		// Find round 1171
		const round1171 = data.rounds.find(r => r.roundNumber === 1171);
		expect(round1171).toBeDefined();
		expect(round1171?.rank).toBe(EXPECTED[1171].rank);
		expect(round1171?.corr).toBeCloseTo(EXPECTED[1171].corr, 3);
		expect(round1171?.mmc).toBeCloseTo(EXPECTED[1171].mmc, 3);
		expect(round1171?.totalModels).toBe(EXPECTED[1171].totalModels);
	}, 30000);

	it('should rank fnc_dl2_994b among thousands of models matching numer.ai leaderboard', async () => {
		const url = buildUrl({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170,
			tournament: TOURNAMENT,
			corrWeight: DEFAULT_SCORE_FORMULA.corrWeight,
			mmcWeight: DEFAULT_SCORE_FORMULA.mmcWeight,
		});

		const response = await fetch(url, {
			headers: { Origin: 'http://localhost:5174' }
		});

		expect(response.ok).toBe(true);

		const data = await response.json() as {
			rounds: Array<{
				roundNumber: number;
				rank: number | null;
				totalModels: number;
			}>;
		};

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();

		// totalModels must reflect ALL staked models for round 1170 (~4046)
		expect(round?.totalModels).toBeGreaterThan(4000);
		// rank computed with custom formula (0.75*v2Corr20 + 2.25*mmc) among staked models
		expect(round?.rank).toBe(EXPECTED[1170].rank);
	}, 30000);

	it('should compute custom score consistently with calculateCustomScore', async () => {
		const url = buildUrl({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170,
			tournament: TOURNAMENT,
			corrWeight: DEFAULT_SCORE_FORMULA.corrWeight,
			mmcWeight: DEFAULT_SCORE_FORMULA.mmcWeight,
		});

		const response = await fetch(url, {
			headers: { Origin: 'http://localhost:5174' }
		});

		const data = await response.json() as {
			rounds: Array<{
				roundNumber: number;
				corr: number | null;
				mmc: number | null;
				customScore: number | null;
			}>;
		};

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();

		if (round?.corr !== null && round?.mmc !== null) {
			const expectedScore = calculateCustomScore(
				round.corr,
				round.mmc,
				DEFAULT_SCORE_FORMULA
			);
			expect(round.customScore).toBeCloseTo(expectedScore!, 4);
		}
	}, 30000);

	it('should return 400 when modelName is missing', async () => {
		const url = `${WORKER_API_URL}/rankings/model-rank?startRound=1170&endRound=1171`;
		const response = await fetch(url, {
			headers: { Origin: 'http://localhost:5174' }
		});
		expect(response.status).toBe(400);
	}, 10000);

	it('should return valid data structure with required fields', async () => {
		const url = buildUrl({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170,
			tournament: TOURNAMENT,
			corrWeight: 0.75,
			mmcWeight: 2.25,
		});

		const response = await fetch(url, {
			headers: { Origin: 'http://localhost:5174' }
		});

		expect(response.ok).toBe(true);

		const data = await response.json() as Record<string, unknown>;

		// Verify response structure
		expect(data).toHaveProperty('modelName');
		expect(data).toHaveProperty('username');
		expect(data).toHaveProperty('modelId');
		expect(data).toHaveProperty('rounds');
		expect(Array.isArray(data.rounds)).toBe(true);

		const rounds = data.rounds as Array<Record<string, unknown>>;
		if (rounds.length > 0) {
			const round = rounds[0];
			expect(round).toHaveProperty('roundNumber');
			expect(round).toHaveProperty('rank');
			expect(round).toHaveProperty('corr');
			expect(round).toHaveProperty('mmc');
			expect(round).toHaveProperty('customScore');
			expect(round).toHaveProperty('totalModels');
		}
	}, 30000);
});
