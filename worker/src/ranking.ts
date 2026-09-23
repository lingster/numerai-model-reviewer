/**
 * How a model's score and rank for a round are defined.
 *
 * Shared so that every producer agrees: the worker ranking live from
 * model_performances, the worker ranking from a stored round field, and
 * precompute building those stored fields. A model's rank is its position when
 * the round's scored models are ordered by score, best first — so any of them
 * must score models identically or ranks disagree between paths.
 */

import { CRYPTO_TOURNAMENT, SIGNALS_TOURNAMENT } from './mappers';
import type { RoundPerfRow } from './perf-queries';

/** Weights applied to a round's metrics to get the score models are ranked by. */
export interface ScoreFormula {
	corrWeight: number;
	mmcWeight: number;
	tcWeight?: number;
}

/** A corr/mmc/tc metric triple (already normalized for the tournament). */
export interface MetricTriple {
	corr: number | null;
	mmc: number | null;
	tc: number | null;
}

/** The MetricTriple members, as the key list the windowed averager takes. */
export const TRIPLE_KEYS = ['corr', 'mmc', 'tc'] as const satisfies readonly (keyof MetricTriple)[];

/**
 * Which pair of Signals metrics a ranking is scored on.
 *
 * `alpha_mpc` is what payouts use up to round ~1362; `neutral` is neutral
 * correlation and neutral contribution, which Numerai pays on from rounds
 * opening on or after 25 September 2026. Numerai publishes both for the same
 * rounds, so either can rank any round. Meaningless for Classic and Crypto,
 * which have one pair.
 */
export type MetricSet = 'corr20_mmc' | 'corr60_mmc60' | 'alpha_mpc' | 'neutral';

export const METRIC_SETS: readonly MetricSet[] = ['corr20_mmc', 'corr60_mmc60', 'alpha_mpc', 'neutral'];

/**
 * The metric pairs a tournament can be ranked on.
 *
 * Classic moved its payout to 3*CORR60 + 15*MMC60 on 28 Aug 2026; the 20-day
 * pair it used before stays available, because a chart of older rounds is still
 * read in those terms. Signals has alpha/mpc and, from rounds opening
 * 2026-09-25, the neutral pair. Crypto publishes one pair only.
 */
export function metricSetsFor(tournament: number): MetricSet[] {
	if (tournament === SIGNALS_TOURNAMENT) return ['alpha_mpc', 'neutral'];
	if (tournament === CRYPTO_TOURNAMENT) return ['corr20_mmc'];
	return ['corr20_mmc', 'corr60_mmc60'];
}

/** What a tournament is ranked on unless asked otherwise: what Numerai pays on. */
export function defaultMetricSetFor(tournament: number): MetricSet {
	if (tournament === SIGNALS_TOURNAMENT) return 'alpha_mpc';
	if (tournament === CRYPTO_TOURNAMENT) return 'corr20_mmc';
	return 'corr60_mmc60';
}

/** `value` as a MetricSet, or the fallback — for request parameters. */
export function asMetricSet(value: unknown, fallback: MetricSet = 'alpha_mpc'): MetricSet {
	return METRIC_SETS.includes(value as MetricSet) ? (value as MetricSet) : fallback;
}

/**
 * Pick the (corr-like, mmc-like) metric pair for the given tournament. Signals
 * is scored on alpha/mpc — or on the neutral pair — which the worker reads into
 * the same corr/mmc slots.
 */
export function pickMetrics(
	row: RoundPerfRow,
	tournament: number,
	metricSet: MetricSet = 'alpha_mpc'
): MetricTriple {
	if (tournament === SIGNALS_TOURNAMENT) {
		return metricSet === 'neutral'
			? { corr: row.neutral_corr ?? null, mmc: row.neutral_mmc ?? null, tc: null }
			: { corr: row.alpha, mmc: row.mpc, tc: null };
	}
	if (metricSet === 'corr60_mmc60') {
		return { corr: row.corr60 ?? null, mmc: row.mmc60 ?? null, tc: row.tc };
	}
	return { corr: row.corr, mmc: row.mmc, tc: row.tc };
}

/** Custom score for a metric triple under the formula. null if no metric present. */
export function scoreFromMetrics(m: MetricTriple, formula: ScoreFormula): number | null {
	if (m.corr === null && m.mmc === null && m.tc === null) return null;
	const score =
		formula.corrWeight * (m.corr ?? 0) +
		formula.mmcWeight * (m.mmc ?? 0) +
		(formula.tcWeight ?? 0) * (m.tc ?? 0);
	return Number.isFinite(score) ? score : null;
}

/**
 * A model's rank among `scores`: how many models scored above it, plus one.
 *
 * Equivalent to its index when the field is sorted best-first, but defined by
 * comparison rather than by sort position, so a stored field ranks a model the
 * same however its scores happen to be ordered.
 */
export function rankAmong(scores: ArrayLike<number>, score: number): number {
	let better = 0;
	for (let i = 0; i < scores.length; i++) {
		if (scores[i] > score) better++;
	}
	return better + 1;
}

/**
 * Competition ranks for a list already ordered best-first: 1, 2, 2, 4. Equal
 * scores share a rank, the same answer rankAmong gives, in one pass instead of
 * one scan per model.
 */
export function rankSortedScores(scores: ReadonlyArray<number>): number[] {
	const ranks: number[] = [];
	for (let i = 0; i < scores.length; i++) {
		ranks.push(i > 0 && scores[i] === scores[i - 1] ? ranks[i - 1] : i + 1);
	}
	return ranks;
}
