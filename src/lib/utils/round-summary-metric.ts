/**
 * Metric selection for the Round Summary distribution chart.
 *
 * The chart can plot the field's distribution by one of four metrics, and the
 * labels are tournament-aware (Signals scores on Alpha/MPC; Classic/Crypto on
 * CORR/MMC — the worker aliases alpha→corr and mpc→mmc for Signals, so the same
 * RoundModelScore.corr/mmc fields carry the right numbers):
 *   - metric1    → corr  (CORR / Alpha)
 *   - metric2    → mmc   (MMC / MPC)
 *   - score      → customScore (the "payout" weighted score)
 *   - percentile → percentile of the custom-score rank (higher = better)
 */
import type { RoundModelScore } from '$lib/types.js';
import { rankToPercentile } from '$lib/utils/ranking-display.js';

const SIGNALS_TOURNAMENT = 11;

export type RoundSummaryMetric = 'metric1' | 'metric2' | 'score' | 'percentile';

export interface MetricOption {
	key: RoundSummaryMetric;
	label: string;
}

/** Toggle options (and their labels) for a tournament. */
export function metricOptions(tournament: number): MetricOption[] {
	const signals = tournament === SIGNALS_TOURNAMENT;
	return [
		{ key: 'metric1', label: signals ? 'Alpha' : 'CORR' },
		{ key: 'metric2', label: signals ? 'MPC' : 'MMC' },
		{ key: 'score', label: 'Payout score' },
		{ key: 'percentile', label: 'Percentile' }
	];
}

/** Human label for a single metric under a tournament. */
export function metricLabel(metric: RoundSummaryMetric, tournament: number): string {
	return metricOptions(tournament).find((o) => o.key === metric)?.label ?? metric;
}

/**
 * Extract the value of `metric` from a model's round score, or null when the
 * underlying field is missing (so the caller can drop it from the distribution).
 */
export function metricValue(model: RoundModelScore, metric: RoundSummaryMetric): number | null {
	switch (metric) {
		case 'metric1':
			return model.corr;
		case 'metric2':
			return model.mmc;
		case 'score':
			return model.customScore;
		case 'percentile':
			return rankToPercentile(model.rank, model.totalModels);
	}
}
