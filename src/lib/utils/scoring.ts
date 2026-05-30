/**
 * Numerai Signals weighted scoring.
 *
 * The current Signals payout-relevant score combines alpha and MPC:
 *   score = SCORE_ALPHA_WEIGHT * alpha + SCORE_MPC_WEIGHT * mpc
 *
 * Kept as a shared, dependency-free module so the comparison bars, the time
 * series chart and any future view all compute the score identically (DRY).
 * Weights are exported so callers can expose them as adjustable defaults that
 * track future scoring-rule changes.
 */

/** Default weight applied to the alpha component. */
export const SCORE_ALPHA_WEIGHT = 0.3;

/** Default weight applied to the MPC component. */
export const SCORE_MPC_WEIGHT = 0.8;

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
