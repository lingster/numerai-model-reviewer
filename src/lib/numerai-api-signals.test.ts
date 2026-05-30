/**
 * Tests for the Numerai Signals tournament (Tournament ID: 11).
 *
 * Signals models are NOT exposed by the Classic `v3UserProfile` query — they
 * must be fetched via `v2SignalsProfile`. Their scores also live in different
 * fields: the headline correlation is `fncV4` and MMC is `mmc20d`, while the
 * Classic `corr`/`corr20V2`/`mmc`/`tc` fields are null.
 *
 * Test layers:
 *  1. Pure mapper unit tests (deterministic, no network) — the TDD core.
 *  2. Live cross-check against the real Numerai GraphQL API for `fncs_zeus`.
 *  3. Worker REST endpoint test via wrangler `unstable_dev`.
 *
 * Ground-truth fixture: model `fncs_zeus` (owner `fish_n_chips`), resolved
 * round 1215 — fncV4 = 0.020263587551686744, mmc20d = 0.007138999205349989.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import {
	mapRoundPerformance,
	mapRoundPerformances,
	type RawRoundModelPerformance
} from '../../worker/src/mappers';

const SIGNALS_TOURNAMENT_ID = 11;
const CLASSIC_TOURNAMENT_ID = 8;
const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';
const TEST_ORIGIN = 'http://localhost:5173';

// Resolved round 1215 for fncs_zeus — values are locked once a round resolves.
const ZEUS_ROUND_1215: RawRoundModelPerformance = {
	roundNumber: 1215,
	roundOpenTime: '2026-03-03T13:16:11Z',
	roundResolveTime: '2026-05-29T20:00:11Z',
	roundResolved: true,
	corr: null,
	corr20V2: null,
	corr60: null,
	corrV4: null,
	mmc: null,
	mmc20d: 0.007138999205349989,
	fnc: null,
	fncV3: null,
	fncV4: 0.020263587551686744,
	tc: null,
	corrMultiplier: 0.3,
	mmcMultiplier: 0.8,
	selectedStakeValue: '0.000000000000000000',
	payout: '0.000000000000000000'
};

// fncs_zeus round 1215 alpha/mpc from v2RoundModelPerformances submissionScores.
const ZEUS_1215_ALPHA = 0.003341;
const ZEUS_1215_MPC = -0.022864;

describe('mapRoundPerformance — Signals (tournament 11)', () => {
	it('maps fncV4 to correlation when classic corr fields are null', () => {
		const mapped = mapRoundPerformance(ZEUS_ROUND_1215, SIGNALS_TOURNAMENT_ID);
		expect(mapped.correlation).toBeCloseTo(0.020263587551686744, 10);
	});

	it('maps mmc20d to mmc for Signals', () => {
		const mapped = mapRoundPerformance(ZEUS_ROUND_1215, SIGNALS_TOURNAMENT_ID);
		expect(mapped.mmc).toBeCloseTo(0.007138999205349989, 10);
	});

	it('exposes fncV4 as fnc for Signals', () => {
		const mapped = mapRoundPerformance(ZEUS_ROUND_1215, SIGNALS_TOURNAMENT_ID);
		expect(mapped.fnc).toBeCloseTo(0.020263587551686744, 10);
	});

	it('prefers fncV4 for correlation even if corrV4/corr20V2 are also present', () => {
		const mapped = mapRoundPerformance(
			{ ...ZEUS_ROUND_1215, fncV4: 0.05, corrV4: 0.01, corr20V2: 0.02 },
			SIGNALS_TOURNAMENT_ID
		);
		expect(mapped.correlation).toBeCloseTo(0.05, 6);
	});

	it('falls back to corrV4 then corr20V2 when fncV4 is null', () => {
		const mapped = mapRoundPerformance(
			{ ...ZEUS_ROUND_1215, fncV4: null, corrV4: 0.0123, corr20V2: 0.02 },
			SIGNALS_TOURNAMENT_ID
		);
		expect(mapped.correlation).toBeCloseTo(0.0123, 6);
	});

	it('preserves round metadata and parses Nmr strings to numbers', () => {
		const mapped = mapRoundPerformance(ZEUS_ROUND_1215, SIGNALS_TOURNAMENT_ID);
		expect(mapped.roundNumber).toBe(1215);
		expect(mapped.roundResolved).toBe(true);
		expect(mapped.selectedStakeValue).toBe(0);
		expect(mapped.payout).toBe(0);
	});
});

describe('mapRoundPerformances — null safety', () => {
	it('maps null/undefined round arrays to an empty list (no crash)', () => {
		expect(mapRoundPerformances(null, SIGNALS_TOURNAMENT_ID)).toEqual([]);
		expect(mapRoundPerformances(undefined, SIGNALS_TOURNAMENT_ID)).toEqual([]);
	});
});

describe('mapRoundPerformance — Classic (tournament 8) is unaffected', () => {
	it('prefers corr20V2 for correlation and mmc for mmc, not the Signals fields', () => {
		const classicRaw: RawRoundModelPerformance = {
			roundNumber: 1163,
			roundResolved: true,
			corr: 0.01,
			corr20V2: -0.0329,
			mmc: -0.026,
			mmc20d: 0.999, // must be ignored for classic
			fncV4: 0.05,
			payout: -0.083,
			selectedStakeValue: 11.05
		};
		const mapped = mapRoundPerformance(classicRaw, CLASSIC_TOURNAMENT_ID);
		expect(mapped.correlation).toBeCloseTo(-0.0329, 6);
		expect(mapped.mmc).toBeCloseTo(-0.026, 6);
		expect(mapped.mmc).not.toBeCloseTo(0.999, 6);
	});
});

describe('Signals live API cross-check (fncs_zeus)', () => {
	async function queryDirect<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
		const response = await fetch(NUMERAI_API_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables })
		});
		const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
		if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join(', '));
		return result.data as T;
	}

	it('returns fncs_zeus via v2SignalsProfile (Classic v3UserProfile returns null)', async () => {
		const signals = await queryDirect<{ v2SignalsProfile: { username: string; accountName: string; tournament: number } | null }>(
			`query($m: String!) { v2SignalsProfile(modelName: $m) { username accountName tournament } }`,
			{ m: 'fncs_zeus' }
		);
		expect(signals.v2SignalsProfile?.username).toBe('fncs_zeus');
		expect(signals.v2SignalsProfile?.accountName).toBe('fish_n_chips');
		expect(signals.v2SignalsProfile?.tournament).toBe(SIGNALS_TOURNAMENT_ID);

		const classic = await queryDirect<{ v3UserProfile: unknown | null }>(
			`query($m: String!) { v3UserProfile(modelName: $m) { id } }`,
			{ m: 'fncs_zeus' }
		);
		expect(classic.v3UserProfile).toBeNull();
	}, 30000);

	it('reports fncV4 and mmc20d for resolved round 1215', async () => {
		const result = await queryDirect<{
			v2SignalsProfile: {
				roundModelPerformances: Array<{ roundNumber: number; fncV4: number | null; mmc20d: number | null }>;
			} | null;
		}>(
			`query($m: String!) { v2SignalsProfile(modelName: $m) { roundModelPerformances { roundNumber fncV4 mmc20d } } }`,
			{ m: 'fncs_zeus' }
		);
		const round = result.v2SignalsProfile?.roundModelPerformances.find((r) => r.roundNumber === 1215);
		expect(round).toBeDefined();
		expect(round?.fncV4).toBeCloseTo(0.020263587551686744, 6);
		expect(round?.mmc20d).toBeCloseTo(0.007138999205349989, 6);
	}, 30000);
});

describe('Signals model performance via Worker REST endpoint', () => {
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
	}, 30000);

	afterAll(async () => {
		if (worker) await worker.stop();
	});

	it('GET /models/fncs_zeus/performance?tournament=11 returns mapped Signals rounds', async () => {
		const response = await worker.fetch('/models/fncs_zeus/performance?tournament=11&username=fish_n_chips', {
			method: 'GET',
			headers: { Origin: TEST_ORIGIN }
		});
		expect(response.status).toBe(200);

		const perf = (await response.json()) as {
			modelName: string;
			username: string;
			rounds: Array<{ roundNumber: number; correlation: number | null; mmc: number | null; fnc: number | null }>;
		};
		expect(perf.modelName).toBe('fncs_zeus');
		expect(perf.username).toBe('fish_n_chips');
		expect(Array.isArray(perf.rounds)).toBe(true);

		const round = perf.rounds.find((r) => r.roundNumber === 1215);
		expect(round).toBeDefined();
		expect(round?.correlation).toBeCloseTo(0.020263587551686744, 6);
		expect(round?.mmc).toBeCloseTo(0.007138999205349989, 6);
	}, 45000);

	it('augments Signals rounds with alpha and mpc (new scoring) from submissionScores', async () => {
		const response = await worker.fetch(
			'/models/fncs_zeus/performance?tournament=11&username=fish_n_chips&modelId=3468a985-2e2d-4333-9879-97f9d764d5cf',
			{ method: 'GET', headers: { Origin: TEST_ORIGIN } }
		);
		expect(response.status).toBe(200);

		const perf = (await response.json()) as {
			rounds: Array<{ roundNumber: number; alpha: number | null; mpc: number | null }>;
		};
		const round = perf.rounds.find((r) => r.roundNumber === 1215);
		expect(round).toBeDefined();
		expect(round?.alpha).toBeCloseTo(ZEUS_1215_ALPHA, 5);
		expect(round?.mpc).toBeCloseTo(ZEUS_1215_MPC, 5);
	}, 45000);
});
