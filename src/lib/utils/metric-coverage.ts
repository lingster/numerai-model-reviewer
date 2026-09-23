/**
 * Telling people when a metric pair simply has no data for the rounds they
 * asked about.
 *
 * Numerai publishes each pair over its own span: the neutral Signals scores
 * start around round 912, and Classic's 60-day pair is published for a subset
 * of rounds and only as far back as our precompute has fetched. A range that
 * reaches past the start of a pair comes back with unranked rounds, which looks
 * like a fault unless the chart says otherwise.
 *
 * Derived from the response rather than a hard-coded round, so widening the
 * backfill moves the notice on its own instead of leaving a stale number in the
 * UI — this is the kind of constant that rots quietly.
 */

import { METRIC_SETS, type MetricSet } from './scoring.js';

/** A ranked round, as the rankings API returns it. */
interface RankedRound {
	roundNumber: number;
	rank: number | null;
}

/**
 * The first round with a rank, when earlier rounds have none — i.e. where this
 * pair's data begins within the requested range. Null when nothing is missing,
 * and when nothing is ranked at all: "data starts at X" needs an X.
 */
export function firstRankedRound(rounds: ReadonlyArray<RankedRound>): number | null {
	const firstRanked = rounds.findIndex((round) => round.rank !== null);
	if (firstRanked <= 0) return null;
	return rounds[firstRanked].roundNumber;
}

/** A sentence for the gap above, naming the pair, or null when there is no gap. */
export function metricCoverageNotice(
	metricSet: MetricSet,
	rounds: ReadonlyArray<RankedRound>
): string | null {
	const from = firstRankedRound(rounds);
	if (from === null) return null;
	const set = METRIC_SETS[metricSet];
	return `No ${set.corrLabel}/${set.mmcLabel} data before round ${from} — earlier rounds have no rank on this pair.`;
}
