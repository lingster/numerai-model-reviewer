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
 *                            &corrWeight=&mmcWeight=
 *   → { modelName, username, modelId, rounds: [{
 *       roundNumber, rank, corr, mmc, customScore, totalModels
 *     }] }
 *
 * For Signals, `corr` and `mmc` in the response are alpha and mpc respectively
 * — the frontend renders them under the same axes (the "New scoring" toggle
 * in the signals tab uses this same alias).
 */
import { SIGNALS_TOURNAMENT } from './mappers';

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

interface RoundPerfRow {
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

/**
 * Look up a model's id/username/canonical-name from D1. Case-insensitive on
 * model_name. Returns null if the model isn't in the precomputed set.
 */
async function lookupModel(
	env: Env,
	modelName: string,
	tournament: number
): Promise<TopModelRow | null> {
	const row = await env.DB.prepare(
		`SELECT model_id, model_name, username
		   FROM top_staked_models
		  WHERE LOWER(model_name) = LOWER(?) AND tournament = ?`
	)
		.bind(modelName, tournament)
		.first<TopModelRow>();
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
	const result = await env.DB.prepare(sql)
		.bind(round, tournament)
		.all<RoundPerfRow>();
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
		const result = await env.DB.prepare(sql)
			.bind(lo, hi, tournament)
			.all<RoundPerfRow & { round_number: number }>();
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
	}
): Promise<ModelRankResponse> {
	const { modelName, startRound, endRound, tournament, formula } = params;
	const targetLower = modelName.toLowerCase();

	const meta = await lookupModel(env, modelName, tournament);

	// Pull the whole range's field data in chunked queries up front (avoids a
	// per-round N+1 that made "Last 500"/"All" take tens of seconds), then rank
	// each round from the in-memory map.
	const fields = await fetchRoundFields(env, startRound, endRound, tournament);

	const rounds: ModelRankRoundResult[] = [];
	for (let r = startRound; r <= endRound; r++) {
		const field = fields.get(r) ?? [];
		const ranked = rankRound(field, targetLower, tournament, formula);
		if (ranked) {
			rounds.push({ ...ranked, roundNumber: r });
		} else {
			rounds.push({
				roundNumber: r,
				rank: null,
				corr: null,
				mmc: null,
				customScore: null,
				totalModels: 0
			});
		}
	}

	return {
		modelName: meta?.model_name ?? modelName,
		username: meta?.username ?? '',
		modelId: meta?.model_id ?? '',
		rounds
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
	const result = await env.DB.prepare(
		`SELECT model_name, username FROM top_staked_models WHERE tournament = ?`
	)
		.bind(tournament)
		.all<{ model_name: string; username: string }>();
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
	}
): Promise<TopModelEntry[]> {
	const { round, tournament, formula, limit } = params;
	const [field, usernames] = await Promise.all([
		fetchRoundField(env, round, tournament),
		fetchUsernameMap(env, tournament)
	]);

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
		scored.push({ modelName: row.model_name, score, corr: corrMetric, mmc: mmcMetric });
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
export async function getCurrentRound(
	env: Env & { NUMERAI_API_URL: string },
	tournament: number
): Promise<number> {
	const response = await fetch(env.NUMERAI_API_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: `query($tournament: Int!) { rounds(tournament: $tournament, limit: 1) { number } }`,
			variables: { tournament }
		})
	});
	if (!response.ok) {
		throw new Error(`Numerai API error: ${response.status}`);
	}
	const result = (await response.json()) as {
		data?: { rounds?: Array<{ number: number }> };
		errors?: Array<{ message: string }>;
	};
	if (result.errors?.length) {
		throw new Error(result.errors.map((e) => e.message).join(', '));
	}
	const round = result.data?.rounds?.[0]?.number;
	if (!round) throw new Error('No rounds returned');
	return round;
}
