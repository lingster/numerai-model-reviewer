/**
 * How a model's score and rank for a round are defined.
 *
 * Shared so that every producer agrees: the worker ranking live from
 * model_performances, the worker ranking from a stored round field, and
 * precompute building those stored fields. A model's rank is its position when
 * the round's scored models are ordered by score, best first — so any of them
 * must score models identically or ranks disagree between paths.
 */

import { SIGNALS_TOURNAMENT } from './mappers';
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
 * Pick the (corr-like, mmc-like) metric pair for the given tournament. Signals
 * is scored on alpha/mpc, which the worker reads into the same columns.
 */
export function pickMetrics(row: RoundPerfRow, tournament: number): MetricTriple {
	if (tournament === SIGNALS_TOURNAMENT) {
		return { corr: row.alpha, mmc: row.mpc, tc: null };
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
