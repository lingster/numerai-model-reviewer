/**
 * Backend integration tests for the Worker rankings API
 *
 * Tests the /rankings/model-rank endpoint directly to verify:
 * - Correct rank computation against all staked models
 * - Correct totalModels count
 * - Correct corr, mmc metric values
 * - Proper error handling
 *
 * Prerequisites:
 * - Worker must be running locally: npm run dev (in worker/)
 * - D1 database must be initialized and populated: npm run precompute:dev
 *
 * Expected data for model "fnc_dl2_994b" (tournament 8, formula 0.75*corr + 2.25*mmc):
 *   Round 1170: rank=13, corr=0.0433, mmc=0.0371, totalModels=4046
 *   Round 1171: rank=14, corr=0.0402, mmc=0.0356, totalModels=4093
 */
import { describe, it, expect } from 'vitest';

// Worker API URL (local development)
const WORKER_URL = 'http://localhost:8787';

// Test constants
const MODEL_NAME = 'fnc_dl2_994b';
const TOURNAMENT = 8;

// Default scoring formula
const DEFAULT_FORMULA = {
	corrWeight: 0.75,
	mmcWeight: 2.25
};

// Expected correct values
const EXPECTED = {
	1170: {
		rank: 13,
		corr: 0.0433,
		mmc: 0.0371,
		totalModels: 4046,
		customScore: 0.75 * 0.0433 + 2.25 * 0.0371 // ≈ 0.11595
	},
	1171: {
		rank: 14,
		corr: 0.0402,
		mmc: 0.0356,
		totalModels: 4093,
		customScore: 0.75 * 0.0402 + 2.25 * 0.0356 // ≈ 0.11025
	}
} as const;

interface ModelRankResponse {
	modelName: string;
	username: string;
	modelId: string;
	rounds: Array<{
		roundNumber: number;
		rank: number | null;
		corr: number | null;
		mmc: number | null;
		customScore: number | null;
		totalModels: number;
	}>;
}

/**
 * Helper to build the model-rank endpoint URL
 */
function buildModelRankUrl(params: {
	modelName: string;
	startRound: number;
	endRound: number;
	tournament?: number;
	corrWeight?: number;
	mmcWeight?: number;
}): string {
	const searchParams = new URLSearchParams({
		modelName: params.modelName,
		startRound: String(params.startRound),
		endRound: String(params.endRound),
		tournament: String(params.tournament ?? TOURNAMENT),
		corrWeight: String(params.corrWeight ?? DEFAULT_FORMULA.corrWeight),
		mmcWeight: String(params.mmcWeight ?? DEFAULT_FORMULA.mmcWeight)
	});
	return `${WORKER_URL}/rankings/model-rank?${searchParams}`;
}

/**
 * Helper to fetch model rank data from the worker
 */
async function fetchModelRank(params: Parameters<typeof buildModelRankUrl>[0]): Promise<ModelRankResponse> {
	const url = buildModelRankUrl(params);
	const response = await fetch(url, {
		headers: { Origin: 'http://localhost:5174' }
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Worker API error (${response.status}): ${errorBody}`);
	}

	return response.json() as Promise<ModelRankResponse>;
}

// ─── Health Check ────────────────────────────────────────────────────────────

describe('Worker API - Health', () => {
	it('should respond to health check', async () => {
		const response = await fetch(`${WORKER_URL}/health`);
		expect(response.ok).toBe(true);
		const data = await response.json() as { status: string };
		expect(data.status).toBe('ok');
	});
});

// ─── Model Rank Endpoint - Validation ────────────────────────────────────────

describe('Worker API - /rankings/model-rank validation', () => {
	it('should return 400 when modelName is missing', async () => {
		const response = await fetch(
			`${WORKER_URL}/rankings/model-rank?startRound=1170&endRound=1171`,
			{ headers: { Origin: 'http://localhost:5174' } }
		);
		expect(response.status).toBe(400);
	});

	it('should return 400 when startRound is missing', async () => {
		const response = await fetch(
			`${WORKER_URL}/rankings/model-rank?modelName=${MODEL_NAME}&endRound=1171`,
			{ headers: { Origin: 'http://localhost:5174' } }
		);
		expect(response.status).toBe(400);
	});

	it('should return 400 when endRound is missing', async () => {
		const response = await fetch(
			`${WORKER_URL}/rankings/model-rank?modelName=${MODEL_NAME}&startRound=1170`,
			{ headers: { Origin: 'http://localhost:5174' } }
		);
		expect(response.status).toBe(400);
	});
});

// ─── Model Rank Endpoint - Response Structure ────────────────────────────────

describe('Worker API - /rankings/model-rank response structure', () => {
	it('should return valid response structure with all required fields', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		expect(data).toHaveProperty('modelName');
		expect(data).toHaveProperty('username');
		expect(data).toHaveProperty('modelId');
		expect(data).toHaveProperty('rounds');
		expect(Array.isArray(data.rounds)).toBe(true);

		if (data.rounds.length > 0) {
			const round = data.rounds[0];
			expect(round).toHaveProperty('roundNumber');
			expect(round).toHaveProperty('rank');
			expect(round).toHaveProperty('corr');
			expect(round).toHaveProperty('mmc');
			expect(round).toHaveProperty('customScore');
			expect(round).toHaveProperty('totalModels');
		}
	});

	it('should return correct model metadata', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		expect(data.modelName).toBe(MODEL_NAME);
	});
});

// ─── Model Rank Endpoint - Ranking Accuracy ──────────────────────────────────

describe('Worker API - /rankings/model-rank ranking accuracy for fnc_dl2_994b', () => {
	it('should return rank=13 for round 1170', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();
		expect(round?.rank).toBe(EXPECTED[1170].rank);
	});

	it('should return rank=14 for round 1171', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1171,
			endRound: 1171
		});

		const round = data.rounds.find(r => r.roundNumber === 1171);
		expect(round).toBeDefined();
		expect(round?.rank).toBe(EXPECTED[1171].rank);
	});

	it('should return totalModels=4046 for round 1170', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();
		expect(round?.totalModels).toBe(EXPECTED[1170].totalModels);
	});

	it('should return totalModels=4093 for round 1171', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1171,
			endRound: 1171
		});

		const round = data.rounds.find(r => r.roundNumber === 1171);
		expect(round).toBeDefined();
		expect(round?.totalModels).toBe(EXPECTED[1171].totalModels);
	});

	it('should return correct corr and mmc for round 1170', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();
		expect(round?.corr).toBeCloseTo(EXPECTED[1170].corr, 3);
		expect(round?.mmc).toBeCloseTo(EXPECTED[1170].mmc, 3);
	});

	it('should return correct corr and mmc for round 1171', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1171,
			endRound: 1171
		});

		const round = data.rounds.find(r => r.roundNumber === 1171);
		expect(round).toBeDefined();
		expect(round?.corr).toBeCloseTo(EXPECTED[1171].corr, 3);
		expect(round?.mmc).toBeCloseTo(EXPECTED[1171].mmc, 3);
	});

	it('should return correct custom scores using default formula', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1171
		});

		const round1170 = data.rounds.find(r => r.roundNumber === 1170);
		expect(round1170?.customScore).toBeCloseTo(EXPECTED[1170].customScore, 3);

		const round1171 = data.rounds.find(r => r.roundNumber === 1171);
		expect(round1171?.customScore).toBeCloseTo(EXPECTED[1171].customScore, 3);
	});

	it('should return both rounds when querying range 1170-1171', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1171
		});

		const roundNumbers = data.rounds.map(r => r.roundNumber);
		expect(roundNumbers).toContain(1170);
		expect(roundNumbers).toContain(1171);
	});
});

// ─── Model Rank Endpoint - Sanity Checks ─────────────────────────────────────

describe('Worker API - /rankings/model-rank sanity checks', () => {
	it('should rank model among thousands of staked models, not just 1', async () => {
		const data = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		const round = data.rounds.find(r => r.roundNumber === 1170);
		expect(round).toBeDefined();
		// Must be ranked among all staked models (thousands), not just 1
		expect(round?.totalModels).toBeGreaterThan(1000);
		// Rank should be reasonable (not 1 out of 1)
		expect(round?.rank).toBeGreaterThan(1);
		expect(round?.rank).toBeLessThan(100);
	});

	it('should compute different ranks with different formula weights', async () => {
		// Fetch with default formula
		const dataDefault = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170
		});

		// Fetch with corr-only formula
		const dataCorrOnly = await fetchModelRank({
			modelName: MODEL_NAME,
			startRound: 1170,
			endRound: 1170,
			corrWeight: 1.0,
			mmcWeight: 0
		});

		const defaultRound = dataDefault.rounds.find(r => r.roundNumber === 1170);
		const corrOnlyRound = dataCorrOnly.rounds.find(r => r.roundNumber === 1170);

		expect(defaultRound).toBeDefined();
		expect(corrOnlyRound).toBeDefined();

		// Different formulas should generally produce different ranks
		// (not guaranteed but very likely)
		// At minimum, custom scores should differ
		expect(defaultRound?.customScore).not.toEqual(corrOnlyRound?.customScore);
	});
});
