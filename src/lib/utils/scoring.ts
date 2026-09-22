/**
 * Numerai Signals weighted scoring.
 *
 * Signals scores are computed from one of two metric pairs ("metric sets"),
 * selected via the Worker's `metricSet` query param:
 *  - alpha_mpc (today's payout pair):    0.3*alpha + 0.8*mpc
 *  - neutral   (Numerai's payout pair for Signals rounds opening on/after
 *               2026-09-25): 0.5*ncorr + 2*nmmc, clipped +/-3.5% server-side
 *
 * Weights AND display labels for both sets live here, once, so every view that
 * shows Signals scoring (rankings, round-summary, models, the time-series
 * chart) reads the same numbers and names instead of restating them (DRY).
 */

export type SignalsMetricSet = 'alpha_mpc' | 'neutral';

export interface MetricSetDefinition {
	key: SignalsMetricSet;
	/** Weight applied to the first (corr-like) component. */
	corrWeight: number;
	/** Weight applied to the second (mmc-like) component. */
	mmcWeight: number;
	/** Short label for the corr-like component (column headers, chart axes). */
	corrLabel: string;
	/** Short label for the mmc-like component. */
	mmcLabel: string;
}

/** The two Signals metric sets Numerai has paid on, keyed by the Worker's
 *  `metricSet` query value. Single source of truth for their weights + labels. */
export const SIGNALS_METRIC_SETS: Record<SignalsMetricSet, MetricSetDefinition> = {
	alpha_mpc: { key: 'alpha_mpc', corrWeight: 0.3, mmcWeight: 0.8, corrLabel: 'Alpha', mmcLabel: 'MPC' },
	neutral: { key: 'neutral', corrWeight: 0.5, mmcWeight: 2, corrLabel: 'NCORR', mmcLabel: 'NMMC' }
};

/** Default metric set: today's alpha+mpc payout pair. */
export const DEFAULT_SIGNALS_METRIC_SET: SignalsMetricSet = 'alpha_mpc';

/**
 * Earliest Signals round Numerai publishes neutral correlation / neutral
 * contribution for. Verified against the live API and our database on
 * 2026-09-22: the oldest Signals round with a neutral score is 912 (data runs
 * 912–1356). Rounds before this have alpha/mpc only, so a range that reaches
 * back past it legitimately comes back with no rank under 'neutral' — not a bug.
 */
export const NEUTRAL_SCORES_FROM_ROUND = 912;

/**
 * Whether to show the "neutral scores start at round N" hint: only when the
 * neutral metric set is active AND the selected range actually reaches rounds
 * that predate neutral scoring, so the hint appears exactly when it explains
 * something the user would otherwise see as unexplained empty ranks.
 */
export function shouldShowNeutralStartHint(metricSet: SignalsMetricSet, startRound: number): boolean {
	return metricSet === 'neutral' && startRound <= NEUTRAL_SCORES_FROM_ROUND;
}

/** Look up a metric set's weights + labels by key. */
export function getMetricSetDefinition(metricSet: SignalsMetricSet): MetricSetDefinition {
	return SIGNALS_METRIC_SETS[metricSet];
}

/**
 * Render "<weight>·<label> + <weight>·<label>" for a metric set, e.g.
 * "0.3·Alpha + 0.8·MPC" — the single source for that text so score-formula
 * descriptions across the UI can't drift from the actual weights.
 */
export function formatMetricSetFormula(metricSet: SignalsMetricSet): string {
	const set = getMetricSetDefinition(metricSet);
	return `${set.corrWeight}·${set.corrLabel} + ${set.mmcWeight}·${set.mmcLabel}`;
}

/** Default weight applied to the alpha component (the alpha_mpc metric set). */
export const SCORE_ALPHA_WEIGHT = SIGNALS_METRIC_SETS.alpha_mpc.corrWeight;

/** Default weight applied to the MPC component (the alpha_mpc metric set). */
export const SCORE_MPC_WEIGHT = SIGNALS_METRIC_SETS.alpha_mpc.mmcWeight;

/**
 * Compute the weighted alpha+mpc score.
 *
 * A missing component is treated as zero so a model is still scored when only
 * one of the two has resolved. The result is null only when BOTH components are
 * absent, so callers can render "N/A" rather than a misleading 0.
 *
 * @param alpha The alpha score (null/undefined if unavailable).
 * @param mpc The MPC score (null/undefined if unavailable).
 * @param alphaWeight Weight for alpha (defaults to {@link SCORE_ALPHA_WEIGHT}).
 * @param mpcWeight Weight for mpc (defaults to {@link SCORE_MPC_WEIGHT}).
 */
export function computeScore(
	alpha: number | null | undefined,
	mpc: number | null | undefined,
	alphaWeight: number = SCORE_ALPHA_WEIGHT,
	mpcWeight: number = SCORE_MPC_WEIGHT
): number | null {
	if ((alpha === null || alpha === undefined) && (mpc === null || mpc === undefined)) {
		return null;
	}
	return alphaWeight * (alpha ?? 0) + mpcWeight * (mpc ?? 0);
}
