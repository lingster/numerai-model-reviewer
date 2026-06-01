/**
 * Translate a Numerai round-number range into a calendar date range, using the
 * round open-times carried by already-fetched performance data.
 *
 * The reviews (/models) page filters by date (startDate/endDate), while URLs and
 * the rankings page speak in round numbers. This lets a `startRound`/`endRound`
 * URL drive the date-based page without any extra API call: we read the open
 * time off the rounds we already have.
 */

export interface RoundStamp {
	roundNumber: number;
	roundOpenTime?: string | null;
}

/** ISO timestamp → 'YYYY-MM-DD' (UTC), or null if unparseable. */
function toDateString(iso: string): string | null {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

type Stamped = { n: number; t: string };

/**
 * Resolve a single target round to a date string. Exact match wins; otherwise
 * snap in the direction that keeps the target inside the visible window:
 *  - 'start' → nearest round at/after the target (clamped to the latest)
 *  - 'end'   → nearest round at/before the target (clamped to the earliest)
 */
function resolve(stamped: Stamped[], target: number, mode: 'start' | 'end'): string | null {
	const exact = stamped.find((r) => r.n === target);
	if (exact) return toDateString(exact.t);

	if (mode === 'start') {
		const atOrAfter = stamped.filter((r) => r.n >= target).sort((a, b) => a.n - b.n)[0];
		const fallbackLatest = stamped[stamped.length - 1];
		return toDateString((atOrAfter ?? fallbackLatest).t);
	}

	const atOrBefore = stamped.filter((r) => r.n <= target).sort((a, b) => b.n - a.n)[0];
	const fallbackEarliest = stamped[0];
	return toDateString((atOrBefore ?? fallbackEarliest).t);
}

/**
 * Map a (startRound, endRound) range to { startDate, endDate } using the open
 * times of `rounds`. Bounds that aren't requested (null/undefined) are omitted;
 * the result is empty when no round carries a timestamp.
 */
export function roundRangeToDates(
	rounds: RoundStamp[],
	startRound?: number | null,
	endRound?: number | null
): { startDate?: string; endDate?: string } {
	const stamped: Stamped[] = rounds
		.filter((r): r is RoundStamp & { roundOpenTime: string } => Boolean(r.roundOpenTime))
		.map((r) => ({ n: r.roundNumber, t: r.roundOpenTime }))
		.sort((a, b) => a.n - b.n);

	if (stamped.length === 0) return {};

	const out: { startDate?: string; endDate?: string } = {};
	if (startRound != null) {
		const d = resolve(stamped, startRound, 'start');
		if (d) out.startDate = d;
	}
	if (endRound != null) {
		const d = resolve(stamped, endRound, 'end');
		if (d) out.endDate = d;
	}
	return out;
}
