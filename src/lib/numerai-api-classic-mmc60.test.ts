/**
 * Tests for Classic's 60-day MMC (Tournament ID: 8).
 *
 * Classic switched its scoring target from the 20-day to the 60-day window on
 * 28 Aug, so MMC60 is the headline MMC. It is NOT a field on
 * `roundModelPerformances` — the GraphQL `RoundModelPerformance` type has no
 * `mmc60` — so the worker sources it per round from `submissionScores` on
 * `v2RoundModelPerformances`, the same mechanism that supplies Signals'
 * alpha/mpc.
 *
 * Numerai publishes mmc60 for Classic only: `latestReps.mmc60`,
 * `latestRanks.mmc60` and `accountLeaderboard.mmc60` are all null for Signals
 * (11) and Crypto (12), so those tournaments are expected to stay null.
 *
 * Ground-truth fixture: model `nofle_17`, resolved round 1215 —
 * mmc = 0.011874324931414626, mmc60 = 0.015356567849344908. The two differ,
 * so a test passing on mmc60 cannot be satisfied by mmc leaking through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';
const TEST_ORIGIN = 'http://localhost:5173';

const NOFLE_MODEL_ID = '75ac8d56-7007-4dfa-bd68-d016c1bdac4e';
const NOFLE_ROUND_1215_MMC = 0.011874324931414626;
const NOFLE_ROUND_1215_MMC60 = 0.015356567849344908;

interface PerfResponse {
	rounds: Array<{ roundNumber: number; mmc: number | null; mmc60: number | null }>;
}

describe('Classic MMC60 via the Worker REST endpoint', () => {
	let worker: Unstable_DevWorker;

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
	}, 60000);

	afterAll(async () => {
		await worker?.stop();
	});

	it('augments Classic rounds with the real per-round mmc60 from submissionScores', async () => {
		const response = await worker.fetch(
			`/models/nofle_17/performance?tournament=8&modelId=${NOFLE_MODEL_ID}`,
			{ method: 'GET', headers: { Origin: TEST_ORIGIN } }
		);
		expect(response.status).toBe(200);

		const perf = (await response.json()) as PerfResponse;
		const round = perf.rounds.find((r) => r.roundNumber === 1215);

		expect(round).toBeDefined();
		expect(round?.mmc).toBeCloseTo(NOFLE_ROUND_1215_MMC, 6);
		expect(round?.mmc60).toBeCloseTo(NOFLE_ROUND_1215_MMC60, 6);
	}, 45000);

	it('populates mmc60 across the resolved history, not just the latest round', async () => {
		const response = await worker.fetch(
			`/models/nofle_17/performance?tournament=8&modelId=${NOFLE_MODEL_ID}`,
			{ method: 'GET', headers: { Origin: TEST_ORIGIN } }
		);
		const perf = (await response.json()) as PerfResponse;

		const scored = perf.rounds.filter((r) => r.mmc !== null);
		const withMmc60 = scored.filter((r) => r.mmc60 !== null);

		expect(scored.length).toBeGreaterThan(100);
		expect(withMmc60.length).toBe(scored.length);
	}, 45000);

	it('leaves mmc60 null for Signals, which does not publish it', async () => {
		const response = await worker.fetch(
			'/models/fncs_zeus/performance?tournament=11&username=fish_n_chips&modelId=3468a985-2e2d-4333-9879-97f9d764d5cf',
			{ method: 'GET', headers: { Origin: TEST_ORIGIN } }
		);
		expect(response.status).toBe(200);

		const perf = (await response.json()) as PerfResponse;
		expect(perf.rounds.length).toBeGreaterThan(0);
		expect(perf.rounds.every((r) => r.mmc60 === null)).toBe(true);
	}, 45000);
});
