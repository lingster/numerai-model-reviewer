/**
 * Staked/unstaked round filter for the rankings chart.
 *
 * The Worker now reports whether a model was staked for each ranked round
 * (per-round `staked: true|false|null`). null means no data for that round —
 * either it predates staked-tracking, or the model is on Crypto (tournament
 * 12), whose stored "staked" flag is the model's CURRENT stake rather than a
 * per-round fact, so the Worker always returns null for it there. A round with
 * no data doesn't belong under either specific filter, only under 'both'
 * (unfiltered — today's behaviour, and the default).
 */

export type StakedFilter = 'staked' | 'unstaked' | 'both';

export const DEFAULT_STAKED_FILTER: StakedFilter = 'both';

/** Whether a round should be shown under the given staked/unstaked/both filter. */
export function passesStakedFilter(
	staked: boolean | null | undefined,
	filter: StakedFilter
): boolean {
	if (filter === 'both') return true;
	if (staked === null || staked === undefined) return false; // no data — excluded from either specific view
	return filter === 'staked' ? staked : !staked;
}
