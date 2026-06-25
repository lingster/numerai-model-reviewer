/**
 * Ranking display helpers.
 *
 * The worker returns a raw 1-based rank (1 = best) plus the size of the ranked
 * field (`totalModels`) for each round. The UI can present this two ways:
 *  - 'rank'       — the raw position; lower is better (1 = top).
 *  - 'percentile' — a 0–100 percentile; higher is better (best ≈ 100).
 *
 * Percentile is derived purely client-side from (rank, totalModels), so the
 * display toggle needs no API or cache change.
 */

export type RankingDisplayMode = 'rank' | 'percentile';

export const RANKING_DISPLAY_MODES: readonly RankingDisplayMode[] = ['rank', 'percentile'];

/** Default display mode on first load (raw rank, today's behaviour). */
export const DEFAULT_RANKING_DISPLAY_MODE: RankingDisplayMode = 'rank';

/**
 * Convert a 1-based rank to a 0–100 percentile where higher is better.
 *
 * Option A formula: `(totalModels - rank + 1) / totalModels * 100`.
 * Best rank (1) → 100; worst rank (N) → 100/N (never exactly 0, and never a
 * divide-by-zero for a single-model field). Returns null when the rank is
 * missing or the field is empty.
 */
export function rankToPercentile(rank: number | null, totalModels: number): number | null {
	if (rank === null || !Number.isFinite(rank)) return null;
	if (!Number.isFinite(totalModels) || totalModels <= 0) return null;
	return ((totalModels - rank + 1) / totalModels) * 100;
}

/**
 * The value to plot/show for a point under the given mode: the raw rank, or the
 * derived percentile.
 */
export function rankDisplayValue(
	rank: number | null,
	totalModels: number,
	mode: RankingDisplayMode
): number | null {
	return mode === 'percentile' ? rankToPercentile(rank, totalModels) : rank;
}

/** Format a percentile for display (one decimal place). */
export function formatPercentile(percentile: number): string {
	return percentile.toFixed(1);
}
