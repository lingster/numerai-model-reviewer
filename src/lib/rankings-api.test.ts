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
import { describe, it, expect, beforeAll } from 'vitest';
import { calculateCustomScore, DEFAULT_SCORE_FORMULA, hasRankableData, latestRoundWithData } from './rankings-api.js';
import type { ModelRankingHistory, ScoreFormula } from './types.js';

// Worker API URL for integration tests. Overridable so CI can point at a
// locally-seeded worker (see .github/workflows/ci.yml); defaults to the local
// `wrangler dev` port for developer machines. Read via globalThis to stay typed
// without pulling in @types/node.
const WORKER_API_URL =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		?.WORKER_API_URL ?? 'http://localhost:8787';

// Must be present in the worker's ALLOWED_ORIGINS (wrangler.toml [vars]).
const ALLOWED_ORIGIN = 'http://localhost:5173';

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
		const score = calculateCustomScore(0.0433, 0.0371, null, DEFAULT_SCORE_FORMULA);
		// 0.75 * 0.0433 + 2.25 * 0.0371 = 0.032475 + 0.083475 = 0.11595
		expect(score).toBeCloseTo(0.11595, 4);
	});

	it('should calculate score for round 1170 expected values', () => {
		const score = calculateCustomScore(
			EXPECTED[1170].corr,
			EXPECTED[1170].mmc,
			null,
			DEFAULT_SCORE_FORMULA
		);
		expect(score).toBeCloseTo(0.1160, 3);
	});

	it('should calculate score for round 1171 expected values', () => {
		const score = calculateCustomScore(
			EXPECTED[1171].corr,
			EXPECTED[1171].mmc,
			null,
			DEFAULT_SCORE_FORMULA
		);
		expect(score).toBeCloseTo(0.1103, 3);
	});

	it('should return null when all metrics are null', () => {
		const score = calculateCustomScore(null, null, null, DEFAULT_SCORE_FORMULA);
		expect(score).toBeNull();
	});

	it('should treat null values as 0 in calculations', () => {
		const score = calculateCustomScore(0.05, null, null, DEFAULT_SCORE_FORMULA);
		// 0.75 * 0.05 + 2.25 * 0 = 0.0375
		expect(score).toBeCloseTo(0.0375, 4);
	});

	it('should handle custom formula weights', () => {
		const formula: ScoreFormula = { corrWeight: 1.0, mmcWeight: 1.0, tcWeight: 0 };
		const score = calculateCustomScore(0.1, 0.2, null, formula);
		// 1.0 * 0.1 + 1.0 * 0.2 = 0.3
		expect(score).toBeCloseTo(0.3, 4);
	});

	it('should handle zero weights', () => {
		const formula: ScoreFormula = { corrWeight: 0, mmcWeight: 0, tcWeight: 0 };
		const score = calculateCustomScore(0.1, 0.2, null, formula);
		expect(score).toBeCloseTo(0, 4);
	});

	it('should handle negative metric values', () => {
		const score = calculateCustomScore(-0.05, -0.03, null, DEFAULT_SCORE_FORMULA);
		// 0.75 * (-0.05) + 2.25 * (-0.03) = -0.0375 + -0.0675 = -0.105
		expect(score).toBeCloseTo(-0.105, 4);
	});
});

describe('hasRankableData - unit tests', () => {
	const makeHistory = (
		ranks: Array<number | null>
	): ModelRankingHistory => ({
		modelId: 'id',
		modelName: 'm',
		username: 'u',
		rankings: ranks.map((rank, i) => ({
			roundNumber: 1000 + i,
			rank,
			customScore: rank === null ? null : 0.01,
			totalModels: rank === null ? 0 : 50
		}))
	});

	it('is false for an empty rankings array', () => {
		expect(hasRankableData(makeHistory([]))).toBe(false);
	});

	it('is false when every round is rank=null (e.g. unstaked / absent model)', () => {
		expect(hasRankableData(makeHistory([null, null, null]))).toBe(false);
	});

	it('is true when at least one round has a non-null rank', () => {
		expect(hasRankableData(makeHistory([null, 7, null]))).toBe(true);
	});

	it('treats rank=0 as rankable (non-null)', () => {
		expect(hasRankableData(makeHistory([0]))).toBe(true);
	});
});

describe('latestRoundWithData - unit tests', () => {
	const history = (rounds: Array<{ roundNumber: number; totalModels: number }>): ModelRankingHistory => ({
		modelId: 'id',
		modelName: 'm',
		username: 'u',
		rankings: rounds.map((r) => ({
			roundNumber: r.roundNumber,
			rank: r.totalModels > 0 ? 1 : null,
			customScore: null,
			totalModels: r.totalModels
		}))
	});

	it('returns null when no round has a populated field', () => {
		expect(latestRoundWithData([history([{ roundNumber: 5, totalModels: 0 }])])).toBeNull();
		expect(latestRoundWithData([])).toBeNull();
	});

	it('returns the latest round whose field is non-empty', () => {
		const h = history([
			{ roundNumber: 10, totalModels: 50 },
			{ roundNumber: 11, totalModels: 50 },
			{ roundNumber: 12, totalModels: 0 } // unresolved tail
		]);
		expect(latestRoundWithData([h])).toBe(11);
	});

	it('considers rounds across multiple histories', () => {
		const a = history([{ roundNumber: 10, totalModels: 5 }]);
		const b = history([{ roundNumber: 14, totalModels: 9 }]);
		expect(latestRoundWithData([a, b])).toBe(14);
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

	const get = (url: string) => fetch(url, { headers: { Origin: ALLOWED_ORIGIN } });

	// Deterministic fixture from worker/test/seed.sql. Synthetic rounds/model so
	// the data never collides with a populated cache.
	const SEED_MODEL = 'ci_seed_model';
	const SEED = {
		990001: { rank: 2, totalModels: 3, corr: 0.0433, mmc: 0.0371 },
		990002: { rank: 2, totalModels: 2, corr: 0.0402, mmc: 0.0356 }
	} as const;
	const seedFormula = { corrWeight: 0.75, mmcWeight: 2.25 } as const;

	// These tests need a running worker (CI starts a local one). When it isn't
	// reachable, or when the seed data isn't loaded, we skip rather than hang.
	let workerReachable = false;
	let seedPresent = false;

	beforeAll(async () => {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const health = await fetch(`${WORKER_API_URL}/health`, { signal: controller.signal });
			clearTimeout(timer);
			workerReachable = health.ok;
		} catch {
			workerReachable = false;
		}

		if (workerReachable) {
			try {
				const res = await get(
					buildUrl({
						modelName: SEED_MODEL,
						startRound: 990001,
						endRound: 990001,
						tournament: TOURNAMENT,
						corrWeight: seedFormula.corrWeight,
						mmcWeight: seedFormula.mmcWeight
					})
				);
				const data = (await res.json()) as { rounds?: Array<{ totalModels: number }> };
				seedPresent = (data.rounds?.[0]?.totalModels ?? 0) > 0;
			} catch {
				seedPresent = false;
			}
			if (!seedPresent) {
				console.warn(`Worker reachable at ${WORKER_API_URL} but seed data absent; data-dependent tests will skip.`);
			}
		} else {
			console.warn(`Worker not reachable at ${WORKER_API_URL}; integration tests will skip.`);
		}
	});

	it('returns correct rank/totalModels/metrics for the seeded model', async (ctx) => {
		if (!workerReachable || !seedPresent) ctx.skip();

		const res = await get(
			buildUrl({
				modelName: SEED_MODEL,
				startRound: 990001,
				endRound: 990002,
				tournament: TOURNAMENT,
				corrWeight: seedFormula.corrWeight,
				mmcWeight: seedFormula.mmcWeight
			})
		);
		expect(res.ok).toBe(true);

		const data = (await res.json()) as {
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

		expect(data.modelName).toBe(SEED_MODEL);
		expect(data.username).toBe('ci_seed_user');

		for (const [roundStr, expected] of Object.entries(SEED)) {
			const roundNumber = Number(roundStr);
			const round = data.rounds.find((r) => r.roundNumber === roundNumber);
			expect(round, `round ${roundNumber} present`).toBeDefined();
			expect(round?.rank).toBe(expected.rank);
			expect(round?.totalModels).toBe(expected.totalModels);
			expect(round?.corr).toBeCloseTo(expected.corr, 4);
			expect(round?.mmc).toBeCloseTo(expected.mmc, 4);
		}
	}, 30000);

	it('ranks the seeded model within its staked field', async (ctx) => {
		if (!workerReachable || !seedPresent) ctx.skip();

		const res = await get(
			buildUrl({
				modelName: SEED_MODEL,
				startRound: 990001,
				endRound: 990001,
				tournament: TOURNAMENT,
				corrWeight: seedFormula.corrWeight,
				mmcWeight: seedFormula.mmcWeight
			})
		);
		expect(res.ok).toBe(true);

		const data = (await res.json()) as {
			rounds: Array<{ roundNumber: number; rank: number | null; totalModels: number }>;
		};
		const round = data.rounds.find((r) => r.roundNumber === 990001);
		expect(round).toBeDefined();
		expect(round?.totalModels).toBe(SEED[990001].totalModels);
		expect(round?.rank).toBeGreaterThanOrEqual(1);
		expect(round?.rank!).toBeLessThanOrEqual(round!.totalModels);
		expect(round?.rank).toBe(SEED[990001].rank);
	}, 30000);

	it('computes custom score consistently with calculateCustomScore', async (ctx) => {
		if (!workerReachable || !seedPresent) ctx.skip();

		const res = await get(
			buildUrl({
				modelName: SEED_MODEL,
				startRound: 990001,
				endRound: 990001,
				tournament: TOURNAMENT,
				corrWeight: seedFormula.corrWeight,
				mmcWeight: seedFormula.mmcWeight
			})
		);
		const data = (await res.json()) as {
			rounds: Array<{ roundNumber: number; corr: number | null; mmc: number | null; customScore: number | null }>;
		};
		const round = data.rounds.find((r) => r.roundNumber === 990001);
		expect(round).toBeDefined();

		if (round && round.corr !== null && round.mmc !== null) {
			const expectedScore = calculateCustomScore(round.corr, round.mmc, null, {
				corrWeight: seedFormula.corrWeight,
				mmcWeight: seedFormula.mmcWeight,
				tcWeight: 0
			});
			expect(round.customScore).toBeCloseTo(expectedScore!, 4);
		}
	}, 30000);

	it('returns 400 when modelName is missing', async (ctx) => {
		if (!workerReachable) ctx.skip();

		const res = await get(`${WORKER_API_URL}/rankings/model-rank?startRound=990001&endRound=990002`);
		expect(res.status).toBe(400);
	}, 10000);

	it('returns a valid data structure with required fields', async (ctx) => {
		if (!workerReachable) ctx.skip();

		const res = await get(
			buildUrl({
				modelName: SEED_MODEL,
				startRound: 990001,
				endRound: 990001,
				tournament: TOURNAMENT,
				corrWeight: seedFormula.corrWeight,
				mmcWeight: seedFormula.mmcWeight
			})
		);
		expect(res.ok).toBe(true);

		const data = (await res.json()) as Record<string, unknown>;
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
