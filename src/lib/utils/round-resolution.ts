/**
 * Round-resolution helpers for the rankings chart.
 *
 * Numerai rounds resolve with a lag: a round can be scored (and therefore
 * rankable) while still "resolving" — its scores are live but not yet final.
 * Resolution is monotonic by round number, so a single `latestResolvedRound`
 * boundary is enough to classify every round: anything above it is resolving.
 */

export type ResolutionFilter = 'both' | 'resolved' | 'resolving';

/**
 * A round is "resolving" (not yet final) when it comes after the latest resolved
 * round. When the boundary is unknown (null — e.g. the API was unreachable), we
 * treat every round as resolved so the chart degrades to its previous behaviour.
 */
export function isRoundResolving(roundNumber: number, latestResolvedRound: number | null): boolean {
	return latestResolvedRound !== null && roundNumber > latestResolvedRound;
}

/** Whether a round should be shown under the given resolved/resolving filter. */
export function passesResolutionFilter(
	roundNumber: number,
	latestResolvedRound: number | null,
	filter: ResolutionFilter
): boolean {
	if (filter === 'both') return true;
	const resolving = isRoundResolving(roundNumber, latestResolvedRound);
	return filter === 'resolving' ? resolving : !resolving;
}
