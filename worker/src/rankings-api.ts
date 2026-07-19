/**
 * Rankings API — D1-backed rank computation.
 *
 * Reads precomputed top-staked-model performance from D1 and computes a
 * model's rank under a user-supplied score formula. Supports Classic (8),
 * Signals (11) and Crypto (12). Signals uses the "new" alpha/mpc scoring
 * regime; Classic/Crypto use corr/mmc.
 *
 * The endpoint contract is pinned by worker/src/rankings-api.test.ts:
 *   GET /rankings/model-rank?modelName=&startRound=&endRound=&tournament=
 *                            &corrWeight=&mmcWeight=&window=
 *   → { modelName, username, modelId, rounds: [{
 *       roundNumber, rank, corr, mmc, customScore, totalModels
 *     }] }
 *
 * `window` (default 1) ranks each round on the trailing N-round average of the
 * metric (MMC20/CORR60-style) instead of the round's own value; the returned
 * corr/mmc are then the windowed averages. window=1 is the per-round behaviour.
 *
 * For Signals, `corr` and `mmc` in the response are alpha and mpc respectively
 * — the frontend renders them under the same axes (the "New scoring" toggle
 * in the signals tab uses this same alias).
 */
import { SIGNALS_TOURNAMENT } from './mappers';
import { d1Retry } from './d1-retry';

export interface Env {
	DB: D1Database;
	NUMERAI_API_URL: string;
}

export interface ScoreFormula {
	corrWeight: number;
	mmcWeight: number;
	tcWeight?: number;
}

export interface ModelRankRoundResult {
	roundNumber: number;
	rank: number | null;
	corr: number | null;
	mmc: number | null;
	customScore: number | null;
	totalModels: number;
}

export interface ModelRankResponse {
	modelName: string;
	username: string;
	modelId: string;
	rounds: ModelRankRoundResult[];
}

interface TopModelRow {
	model_id: string;
	model_name: string;
	username: string;
}

export interface RoundPerfRow {
	model_name: string;
	corr: number | null;
	mmc: number | null;
	tc: number | null;
	alpha: number | null;
	mpc: number | null;
	stake_value: number | null;
}

/** Pick the (corr-like, mmc-like) metric pair for the given tournament. */
function pickMetrics(row: RoundPerfRow, tournament: number): {
	corrMetric: number | null;
	mmcMetric: number | null;
	tcMetric: number | null;
} {
	if (tournament === SIGNALS_TOURNAMENT) {
		return { corrMetric: row.alpha, mmcMetric: row.mpc, tcMetric: null };
	}
	return { corrMetric: row.corr, mmcMetric: row.mmc, tcMetric: row.tc };
}

/** A corr/mmc/tc metric triple (already normalized for the tournament). */
export interface MetricTriple {
	corr: number | null;
	mmc: number | null;
	tc: number | null;
}

/** Custom score for a metric triple under the formula. null if no metric present. */
function scoreFromMetrics(m: MetricTriple, formula: ScoreFormula): number | null {
	if (m.corr === null && m.mmc === null && m.tc === null) return null;
	const score =
		formula.corrWeight * (m.corr ?? 0) +
		formula.mmcWeight * (m.mmc ?? 0) +
		(formula.tcWeight ?? 0) * (m.tc ?? 0);
	return Number.isFinite(score) ? score : null;
}

/**
 * Build, for every model, the trailing `window`-round average (by round number)
 * of its corr/mmc/tc metrics at each round it has a row — i.e. the MMC20/CORR60
 * style smoothing Numerai's leaderboard uses. Averages skip null values per
 * metric (a metric with no non-null value in the window stays null), and the
 * window is measured by round number so gaps (unstaked rounds) don't inflate it.
 * Metrics are normalized per tournament first (Signals → alpha/mpc).
 *
 * Returns modelNameLower → (round → averaged MetricTriple). A model's entry for
 * round r is the average over rounds in [r-window+1, r] that it actually has.
 */
export function buildWindowedMetrics(
	fields: Map<number, RoundPerfRow[]>,
	tournament: number,
	window: number
): Map<string, Map<number, MetricTriple>> {
	// Group each model's per-round metrics together.
	const perModel = new Map<string, Array<{ round: number } & MetricTriple>>();
	for (const [round, rows] of fields) {
		for (const row of rows) {
			const { corrMetric, mmcMetric, tcMetric } = pickMetrics(row, tournament);
			const key = row.model_name.toLowerCase();
			const entry = { round, corr: corrMetric, mmc: mmcMetric, tc: tcMetric };
			const list = perModel.get(key);
			if (list) list.push(entry);
			else perModel.set(key, [entry]);
		}
	}

	const result = new Map<string, Map<number, MetricTriple>>();
	for (const [key, entries] of perModel) {
		entries.sort((a, b) => a.round - b.round);

		// Slide a width-`window` window (by round number) with running per-metric
		// sums/counts so each round's average is O(1) amortized.
		let lo = 0;
		let sumCorr = 0, cntCorr = 0;
		let sumMmc = 0, cntMmc = 0;
		let sumTc = 0, cntTc = 0;
		const apply = (e: { round: number } & MetricTriple, sign: 1 | -1) => {
			if (e.corr !== null) { sumCorr += sign * e.corr; cntCorr += sign; }
			if (e.mmc !== null) { sumMmc += sign * e.mmc; cntMmc += sign; }
			if (e.tc !== null) { sumTc += sign * e.tc; cntTc += sign; }
		};

		const byRound = new Map<number, MetricTriple>();
		for (let hi = 0; hi < entries.length; hi++) {
			apply(entries[hi], 1);
			while (entries[lo].round <= entries[hi].round - window) {
				apply(entries[lo], -1);
				lo++;
			}
			byRound.set(entries[hi].round, {
				corr: cntCorr > 0 ? sumCorr / cntCorr : null,
				mmc: cntMmc > 0 ? sumMmc / cntMmc : null,
				tc: cntTc > 0 ? sumTc / cntTc : null
			});
		}
		result.set(key, byRound);
	}
	return result;
}

/**
 * Rank a single round's staked field using pre-averaged windowed metrics.
 * `field` defines the ranked set (models staked at `round`); each model's score
 * comes from its windowed average at that round.
 */
function rankRoundFromWindowed(
	field: RoundPerfRow[],
	round: number,
	windowed: Map<string, Map<number, MetricTriple>>,
	targetModelLower: string,
	formula: ScoreFormula
): ModelRankRoundResult {
	const scored: Array<{ modelName: string; score: number; corr: number | null; mmc: number | null }> = [];
	for (const row of field) {
		const m = windowed.get(row.model_name.toLowerCase())?.get(round);
		if (!m) continue;
		const score = scoreFromMetrics(m, formula);
		if (score === null) continue;
		scored.push({ modelName: row.model_name, score, corr: m.corr, mmc: m.mmc });
	}

	scored.sort((a, b) => b.score - a.score);
	const totalModels = scored.length;

	const idx = scored.findIndex((s) => s.modelName.toLowerCase() === targetModelLower);
	if (idx < 0) {
		return { roundNumber: round, rank: null, corr: null, mmc: null, customScore: null, totalModels };
	}
	return {
		roundNumber: round,
		rank: idx + 1,
		corr: scored[idx].corr,
		mmc: scored[idx].mmc,
		customScore: scored[idx].score,
		totalModels
	};
}

/**
 * Look up a model's id/username/canonical-name from D1. Case-insensitive on
 * model_name. Returns null if the model isn't in the precomputed set.
 */
async function lookupModel(
	env: Env,
	modelName: string,
	tournament: number
): Promise<TopModelRow | null> {
	const row = await d1Retry(() =>
		env.DB.prepare(
			`SELECT model_id, model_name, username
			   FROM top_staked_models
			  WHERE LOWER(model_name) = LOWER(?) AND tournament = ?`
		)
			.bind(modelName, tournament)
			.first<TopModelRow>()
	);
	return row ?? null;
}

/**
 * Fetch all staked models' performance for a round and tournament. "Staked"
 * here means `stake_value > 0` for Classic/Signals; Crypto rows have no stake
 * data, so we include every row (the precompute writes one row per model).
 */
async function fetchRoundField(
	env: Env,
	round: number,
	tournament: number
): Promise<RoundPerfRow[]> {
	const sql =
		tournament === 12
			? `SELECT model_name, corr, mmc, tc, alpha, mpc, stake_value
			     FROM model_performances
			    WHERE round_number = ? AND tournament = ?`
			: `SELECT model_name, corr, mmc, tc, alpha, mpc, stake_value
			     FROM model_performances
			    WHERE round_number = ? AND tournament = ?
			      AND stake_value IS NOT NULL AND stake_value > 0`;
	const result = await d1Retry(() =>
		env.DB.prepare(sql)
			.bind(round, tournament)
			.all<RoundPerfRow>()
	);
	return result.results ?? [];
}

// Rounds per batched range query. Ranking needs every staked model's row for
// each round, so a single all-rounds query can be huge (models × rounds);
// chunking keeps each result set bounded while turning the old per-round N+1
// (one query per round) into ~range/CHUNK queries.
const RANGE_CHUNK_ROUNDS = 120;

/**
 * Fetch the staked field for every round in [startRound, endRound], grouped by
 * round number. Issues one query per RANGE_CHUNK_ROUNDS window rather than one
 * per round. Rounds with no rows simply don't appear in the map.
 */
async function fetchRoundFields(
	env: Env,
	startRound: number,
	endRound: number,
	tournament: number
): Promise<Map<number, RoundPerfRow[]>> {
	const stakeFilter =
		tournament === 12 ? '' : ' AND stake_value IS NOT NULL AND stake_value > 0';
	const sql = `SELECT round_number, model_name, corr, mmc, tc, alpha, mpc, stake_value
		     FROM model_performances
		    WHERE round_number BETWEEN ? AND ? AND tournament = ?${stakeFilter}`;

	const byRound = new Map<number, RoundPerfRow[]>();
	for (let lo = startRound; lo <= endRound; lo += RANGE_CHUNK_ROUNDS) {
		const hi = Math.min(lo + RANGE_CHUNK_ROUNDS - 1, endRound);
		const result = await d1Retry(() =>
			env.DB.prepare(sql)
				.bind(lo, hi, tournament)
				.all<RoundPerfRow & { round_number: number }>()
		);
		for (const r of result.results ?? []) {
			const list = byRound.get(r.round_number);
			if (list) list.push(r);
			else byRound.set(r.round_number, [r]);
		}
	}
	return byRound;
}

/**
 * Compute the model's rank for one round given the precomputed field.
 * Models whose metric pair yields no numeric score are excluded from the
 * field (they can't be ranked).
 */
function rankRound(
	field: RoundPerfRow[],
	targetModelLower: string,
	tournament: number,
	formula: ScoreFormula
): ModelRankRoundResult | null {
	const scored: Array<{
		modelName: string;
		score: number;
		corr: number | null;
		mmc: number | null;
	}> = [];

	for (const row of field) {
		const { corrMetric, mmcMetric, tcMetric } = pickMetrics(row, tournament);
		if (corrMetric === null && mmcMetric === null && tcMetric === null) continue;
		const score =
			formula.corrWeight * (corrMetric ?? 0) +
			formula.mmcWeight * (mmcMetric ?? 0) +
			(formula.tcWeight ?? 0) * (tcMetric ?? 0);
		if (!Number.isFinite(score)) continue;
		scored.push({
			modelName: row.model_name,
			score,
			corr: corrMetric,
			mmc: mmcMetric
		});
	}

	scored.sort((a, b) => b.score - a.score);
	const totalModels = scored.length;

	const idx = scored.findIndex(
		(s) => s.modelName.toLowerCase() === targetModelLower
	);
	if (idx < 0) return { roundNumber: 0, rank: null, corr: null, mmc: null, customScore: null, totalModels };

	return {
		roundNumber: 0,
		rank: idx + 1,
		corr: scored[idx].corr,
		mmc: scored[idx].mmc,
		customScore: scored[idx].score,
		totalModels
	};
}

/**
 * Compute ranks for a model over [startRound, endRound]. Reads everything
 * from D1 — no live API calls in the request path.
 */
export async function getModelRank(
	env: Env,
	params: {
		modelName: string;
		startRound: number;
		endRound: number;
		tournament: number;
		formula: ScoreFormula;
		/**
		 * Trailing round window for rank computation. 1 (default) ranks each round
		 * on its own metrics. N>1 ranks each round on the trailing N-round average
		 * of the metric (MMC20/CORR60-style), matching Numerai's leaderboard.
		 */
		window?: number;
	}
): Promise<ModelRankResponse> {
	const { modelName, startRound, endRound, tournament, formula } = params;
	const window = Math.max(1, Math.floor(params.window ?? 1));
	const targetLower = modelName.toLowerCase();

	const meta = await lookupModel(env, modelName, tournament);

	const empty = (r: number): ModelRankRoundResult => ({
		roundNumber: r,
		rank: null,
		corr: null,
		mmc: null,
		customScore: null,
		totalModels: 0
	});

	const rounds: ModelRankRoundResult[] = [];

	if (window > 1) {
		// Fetch back `window-1` extra rounds so the earliest target round still has
		// a full trailing window, then average each model's metrics before ranking.
		const fetchStart = Math.max(1, startRound - (window - 1));
		const fields = await fetchRoundFields(env, fetchStart, endRound, tournament);
		const windowed = buildWindowedMetrics(fields, tournament, window);
		for (let r = startRound; r <= endRound; r++) {
			const field = fields.get(r) ?? [];
			rounds.push(
				field.length === 0 ? empty(r) : rankRoundFromWindowed(field, r, windowed, targetLower, formula)
			);
		}
	} else {
		// Per-round ranking. Pull the whole range's field data in chunked queries up
		// front (avoids a per-round N+1 that made "Last 500"/"All" take tens of
		// seconds), then rank each round from the in-memory map.
		const fields = await fetchRoundFields(env, startRound, endRound, tournament);
		for (let r = startRound; r <= endRound; r++) {
			const field = fields.get(r) ?? [];
			const ranked = rankRound(field, targetLower, tournament, formula);
			rounds.push(ranked ? { ...ranked, roundNumber: r } : empty(r));
		}
	}

	return {
		modelName: meta?.model_name ?? modelName,
		username: meta?.username ?? '',
		modelId: meta?.model_id ?? '',
		rounds
	};
}

/** Cache coverage for a tournament: the round range present in model_performances. */
export interface CacheStatus {
	tournament: number;
	latestRound: number | null;
	earliestRound: number | null;
}

/**
 * Report the round range the precomputed cache currently covers for a tournament
 * (min/max round_number in model_performances). Used by the UI to tell users
 * which rounds have data when a requested range comes back empty — the cache
 * lags the live current round by however long since the last precompute run.
 * Returns nulls when the cache holds no rows for the tournament.
 */
export async function getCacheStatus(env: Env, tournament: number): Promise<CacheStatus> {
	const row = await d1Retry(() =>
		env.DB.prepare(
			`SELECT MAX(round_number) AS latestRound, MIN(round_number) AS earliestRound
			   FROM model_performances
			  WHERE tournament = ?`
		)
			.bind(tournament)
			.first<{ latestRound: number | null; earliestRound: number | null }>()
	);
	return {
		tournament,
		latestRound: row?.latestRound ?? null,
		earliestRound: row?.earliestRound ?? null
	};
}

/** Top-N entry returned by /rankings/top-models. */
export interface TopModelEntry {
	modelName: string;
	username: string;
	rank: number;
	corr: number | null;
	mmc: number | null;
	customScore: number;
	totalModels: number;
}

/**
 * Map of model_name (lowercased) → owning account username for a tournament.
 * model_performances doesn't store the username, so we join it in from
 * top_staked_models. For Signals/Crypto the username equals the model name.
 */
async function fetchUsernameMap(
	env: Env,
	tournament: number
): Promise<Map<string, string>> {
	const result = await d1Retry(() =>
		env.DB.prepare(
			`SELECT model_name, username FROM top_staked_models WHERE tournament = ?`
		)
			.bind(tournament)
			.all<{ model_name: string; username: string }>()
	);
	const map = new Map<string, string>();
	for (const row of result.results ?? []) {
		map.set(row.model_name.toLowerCase(), row.username);
	}
	return map;
}

/**
 * Top-N models for a single round under the given formula. Reads the precomputed
 * field from D1 and returns the top `limit` entries by custom score.
 */
export async function getTopModelsForRound(
	env: Env,
	params: {
		round: number;
		tournament: number;
		formula: ScoreFormula;
		limit: number;
		/** Trailing round window (see getModelRank). 1 = rank on this round alone. */
		window?: number;
	}
): Promise<TopModelEntry[]> {
	const { round, tournament, formula, limit } = params;
	const window = Math.max(1, Math.floor(params.window ?? 1));

	const scored: Array<{
		modelName: string;
		score: number;
		corr: number | null;
		mmc: number | null;
	}> = [];

	let usernames: Map<string, string>;

	if (window > 1) {
		// Average each staked model's metrics over the trailing window before
		// ranking, so the table matches the windowed chart (MMC20/CORR60).
		const fetchStart = Math.max(1, round - (window - 1));
		const [fields, userMap] = await Promise.all([
			fetchRoundFields(env, fetchStart, round, tournament),
			fetchUsernameMap(env, tournament)
		]);
		usernames = userMap;
		const windowed = buildWindowedMetrics(fields, tournament, window);
		const field = fields.get(round) ?? [];
		for (const row of field) {
			const m = windowed.get(row.model_name.toLowerCase())?.get(round);
			if (!m) continue;
			const score = scoreFromMetrics(m, formula);
			if (score === null) continue;
			scored.push({ modelName: row.model_name, score, corr: m.corr, mmc: m.mmc });
		}
	} else {
		const [field, userMap] = await Promise.all([
			fetchRoundField(env, round, tournament),
			fetchUsernameMap(env, tournament)
		]);
		usernames = userMap;
		for (const row of field) {
			const { corrMetric, mmcMetric, tcMetric } = pickMetrics(row, tournament);
			const score = scoreFromMetrics({ corr: corrMetric, mmc: mmcMetric, tc: tcMetric }, formula);
			if (score === null) continue;
			scored.push({ modelName: row.model_name, score, corr: corrMetric, mmc: mmcMetric });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	const totalModels = scored.length;

	// limit <= 0 means "return the whole ranked field" — the frontend pages and
	// searches it client-side so users can find any staked model, not just top N.
	const ranked = limit > 0 ? scored.slice(0, limit) : scored;
	return ranked.map((s, i) => ({
		modelName: s.modelName,
		username: usernames.get(s.modelName.toLowerCase()) ?? '',
		rank: i + 1,
		corr: s.corr,
		mmc: s.mmc,
		customScore: s.score,
		totalModels
	}));
}

/**
 * Live-API lookup for the current round number for a tournament. Bypasses D1
 * since precompute may lag and the UI wants the freshest round to populate
 * its default range. Cached by the worker layer (KV) if desired.
 */
/** POST a `rounds(...)` GraphQL query to Numerai and return the parsed `rounds`
 *  array. Shared by getCurrentRound / getLatestResolvedRound so the fetch,
 *  error-handling, and typing live in one place. */
async function fetchRounds<R>(
	env: Env & { NUMERAI_API_URL: string },
	query: string,
	tournament: number
): Promise<R[]> {
	const response = await fetch(env.NUMERAI_API_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables: { tournament } })
	});
	if (!response.ok) {
		throw new Error(`Numerai API error: ${response.status}`);
	}
	const result = (await response.json()) as {
		data?: { rounds?: R[] };
		errors?: Array<{ message: string }>;
	};
	if (result.errors?.length) {
		throw new Error(result.errors.map((e) => e.message).join(', '));
	}
	return result.data?.rounds ?? [];
}

export async function getCurrentRound(
	env: Env & { NUMERAI_API_URL: string },
	tournament: number
): Promise<number> {
	const rounds = await fetchRounds<{ number: number }>(
		env,
		`query($tournament: Int!) { rounds(tournament: $tournament, limit: 1) { number } }`,
		tournament
	);
	const round = rounds[0]?.number;
	if (!round) throw new Error('No rounds returned');
	return round;
}

/** Highest round flagged resolved, or null if none. Pure — unit tested. */
export function computeLatestResolvedRound(
	rounds: Array<{ number: number; resolvedGeneral: boolean }>
): number | null {
	const resolved = rounds.filter((r) => r.resolvedGeneral).map((r) => r.number);
	return resolved.length ? Math.max(...resolved) : null;
}

/**
 * The latest fully-resolved round for a tournament, or null if none of the
 * recent rounds are resolved. Crypto/Signals resolve with a lag (a run can be
 * scored but not yet resolved), so the frontend uses this boundary to shade
 * "resolving" rounds. Fetches the most recent rounds and takes the max resolved
 * number (resolution is monotonic by round). Scans a generous window so the lag
 * is always covered.
 */
export async function getLatestResolvedRound(
	env: Env & { NUMERAI_API_URL: string },
	tournament: number
): Promise<number | null> {
	const rounds = await fetchRounds<{ number: number; resolvedGeneral: boolean }>(
		env,
		`query($tournament: Int!) { rounds(tournament: $tournament, limit: 60) { number resolvedGeneral } }`,
		tournament
	);
	return computeLatestResolvedRound(rounds);
}
