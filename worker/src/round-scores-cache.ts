/**
 * Persistent per-round cache for the metrics that only `submissionScores`
 * carries: Classic's mmc60 and Signals' alpha/mpc.
 *
 * Why this exists: those scores are not fields on `roundModelPerformances`, so
 * they need a second GraphQL call — and that call returns a model's *entire*
 * scored history (~375 rounds x ~20 scores, ~420KB) with no way to ask for a
 * single round. Refetching and rewriting that on every page view is the waste
 * this module removes.
 *
 * Three things keep it cheap, in order of what they save:
 *
 *  1. Coverage is tracked in one watermark row per model, not by storing a row
 *     for every round looked at. Only rounds that actually have a score get a
 *     row, so a model costs ~375 rows instead of ~1000.
 *  2. Writes are diffed against what is already cached. A round's scores are
 *     final once its 60-day scoring window closes, so in the steady state a
 *     refresh writes the watermark and nothing else.
 *  3. The still-mutable tail is only re-fetched every TAIL_REFRESH_SECONDS.
 *     Views inside that interval are served entirely from D1: no upstream
 *     request, no writes.
 */

import { d1Retry } from './d1-retry';

/**
 * The submission-sourced metrics we persist per round — the union across
 * tournaments, since each scores on a different subset:
 *   Classic  mmc60        (corr/mmc come from roundModelPerformances)
 *   Signals  alpha, mpc, neutral_corr, neutral_mmc  (ditto)
 *   Crypto   corr, mmc    (roundModelPerformances carries no scores at all)
 * Only a tournament's own metrics are ever read or written; the rest stay null.
 */
export interface RoundScores {
	corr: number | null;
	mmc: number | null;
	mmc60: number | null;
	alpha: number | null;
	mpc: number | null;
	/** Signals' neutral pair, named as Numerai's submissionScores name them. */
	neutral_corr: number | null;
	neutral_mmc: number | null;
}

/** The RoundScores members, for iterating without restating them. */
export const SCORE_FIELDS = [
	'corr',
	'mmc',
	'mmc60',
	'alpha',
	'mpc',
	'neutral_corr',
	'neutral_mmc'
] as const satisfies readonly (keyof RoundScores)[];

/** The round range already fetched for a model, and when it was last topped up. */
export interface Coverage {
	fromRound: number;
	toRound: number;
	updatedAt: number;
}

export interface CachedRoundScores {
	scores: Map<number, RoundScores>;
	coverage: Coverage | null;
}

/**
 * How many rounds back from the newest can still be re-scored. Classic scores
 * over a 60-day window, so a round older than this is final; the extra margin
 * absorbs late resolution.
 */
export const MUTABLE_ROUND_WINDOW = 70;

/** How long a cached tail is served before the mutable rounds are refreshed. */
export const TAIL_REFRESH_SECONDS = 900;

interface RoundScoreRow {
	round_number: number;
	corr: number | null;
	mmc: number | null;
	mmc60: number | null;
	alpha: number | null;
	mpc: number | null;
}

interface CoverageRow {
	covered_from_round: number;
	covered_to_round: number;
	updated_at: number;
}

/** True when a round carries nothing worth a row. */
function isEmpty(s: RoundScores): boolean {
	// `== null` covers undefined too: a caller built before a field existed (or a
	// row read back from a database that predates it) leaves it missing rather
	// than null, and an unscored round must not look scored because of that.
	return SCORE_FIELDS.every((f) => s[f] == null);
}

/** Everything cached for a model: its scored rounds and its coverage watermark. */
export async function readCachedRoundScores(
	db: D1Database,
	modelId: string,
	tournament: number
): Promise<CachedRoundScores> {
	const [scoreRows, coverageRow] = await Promise.all([
		d1Retry(() =>
			db
				.prepare(
					`SELECT round_number, corr, mmc, mmc60, alpha, mpc
					 FROM model_round_scores
					 WHERE model_id = ? AND tournament = ?`
				)
				.bind(modelId, tournament)
				.all<RoundScoreRow>()
		),
		d1Retry(() =>
			db
				.prepare(
					`SELECT covered_from_round, covered_to_round, updated_at
					 FROM model_score_coverage
					 WHERE model_id = ? AND tournament = ?`
				)
				.bind(modelId, tournament)
				.first<CoverageRow>()
		)
	]);

	const scores = new Map<number, RoundScores>();
	for (const row of scoreRows.results ?? []) {
		scores.set(row.round_number, {
			corr: row.corr,
			mmc: row.mmc,
			mmc60: row.mmc60,
			alpha: row.alpha,
			mpc: row.mpc
		});
	}

	return {
		scores,
		coverage: coverageRow
			? {
					fromRound: coverageRow.covered_from_round,
					toRound: coverageRow.covered_to_round,
					updatedAt: coverageRow.updated_at
				}
			: null
	};
}

/**
 * The `lastNRounds` window that still needs fetching, or null when the cache
 * can serve the request on its own.
 *
 * `lastNRounds` is a round-number window (not a count), so it is expressed
 * relative to `latestRound`: far enough back to cover rounds opened since the
 * watermark, plus the tail whose scores can still move.
 */
export function computeFetchWindow(
	coverage: Coverage | null,
	latestRound: number,
	maxWindow: number,
	nowSeconds: number
): number | null {
	// Never fetched: take the whole history, once.
	if (!coverage) return maxWindow;

	const newRounds = Math.max(latestRound - coverage.toRound, 0);
	const isFresh = nowSeconds - coverage.updatedAt < TAIL_REFRESH_SECONDS;

	// Nothing new upstream and the tail was checked recently — serve from D1.
	if (newRounds === 0 && isFresh) return null;

	return Math.min(newRounds + MUTABLE_ROUND_WINDOW, maxWindow);
}

/**
 * The subset of `fresh` worth writing: rounds whose values actually differ from
 * what is cached. Empty rounds are dropped — coverage is what records that we
 * looked at them, so they need no row.
 */
export function diffRoundScores(
	cached: ReadonlyMap<number, RoundScores>,
	fresh: ReadonlyMap<number, RoundScores>
): Map<number, RoundScores> {
	const changed = new Map<number, RoundScores>();

	for (const [round, next] of fresh) {
		if (isEmpty(next)) continue;

		const prev = cached.get(round);
		if (prev && SCORE_FIELDS.every((f) => prev[f] === next[f])) {
			continue;
		}
		changed.set(round, next);
	}

	return changed;
}

/**
 * Persist changed rounds and the coverage watermark in one atomic batch, so the
 * watermark can never claim rounds whose rows failed to land.
 */
export async function writeRoundScores(
	db: D1Database,
	modelId: string,
	tournament: number,
	changed: ReadonlyMap<number, RoundScores>,
	coverage: Coverage
): Promise<void> {
	const scoreStatement = db.prepare(
		`INSERT OR REPLACE INTO model_round_scores
		   (model_id, tournament, round_number, corr, mmc, mmc60, alpha, mpc, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);

	const statements = [...changed].map(([round, s]) =>
		scoreStatement.bind(
			modelId,
			tournament,
			round,
			s.corr,
			s.mmc,
			s.mmc60,
			s.alpha,
			s.mpc,
			coverage.updatedAt
		)
	);

	statements.push(
		db
			.prepare(
				`INSERT OR REPLACE INTO model_score_coverage
				   (model_id, tournament, covered_from_round, covered_to_round, updated_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(modelId, tournament, coverage.fromRound, coverage.toRound, coverage.updatedAt)
	);

	await d1Retry(() => db.batch(statements));
}
