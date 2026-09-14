/**
 * Trailing-window averaging over per-round metric values.
 *
 * Numerai's reputation-style metrics (MMC20, CORR60, …) are the mean of a
 * model's per-round scores over the last N *rounds*. This module owns that one
 * algorithm; callers supply the rounds and name the metrics they want averaged.
 *
 * The window is measured by round number, not by array position, so a model
 * that skipped rounds gets a genuine "last N rounds" window rather than one
 * stretched over its sparse history.
 */

/** One round's values for the metrics being averaged. */
export interface RoundMetrics<K extends string> {
	round: number;
	values: Readonly<Partial<Record<K, number | null | undefined>>>;
}

/**
 * For every round present in `entries`, the mean of each named metric over the
 * rounds in `[round - window + 1, round]`.
 *
 * Null, undefined and non-finite values are skipped: they lower the count
 * rather than the mean, and a metric with no usable value in the window
 * averages to null instead of 0.
 *
 * O(n log n) for the sort, O(n · keys) for the sweep.
 */
export function computeTrailingAverages<K extends string>(
	entries: ReadonlyArray<RoundMetrics<K>>,
	keys: readonly K[],
	window: number
): Map<number, Record<K, number | null>> {
	if (!Number.isFinite(window) || window <= 0) {
		throw new RangeError(`window must be a positive number, got ${window}`);
	}

	const result = new Map<number, Record<K, number | null>>();
	if (entries.length === 0) return result;

	const sorted = [...entries].sort((a, b) => a.round - b.round);

	const sums = {} as Record<K, number>;
	const counts = {} as Record<K, number>;
	for (const key of keys) {
		sums[key] = 0;
		counts[key] = 0;
	}

	/** Add (sign 1) or evict (sign -1) one round's values from the running window. */
	const apply = (entry: RoundMetrics<K>, sign: 1 | -1) => {
		for (const key of keys) {
			const value = entry.values[key];
			if (value !== null && value !== undefined && Number.isFinite(value)) {
				sums[key] += sign * value;
				counts[key] += sign;
			}
		}
	};

	let lo = 0;
	for (let hi = 0; hi < sorted.length; hi++) {
		apply(sorted[hi], 1);

		// Evict rounds that have fallen out of the trailing window. `lo` can never
		// pass `hi`, since sorted[hi].round is always inside its own window.
		while (sorted[lo].round <= sorted[hi].round - window) {
			apply(sorted[lo], -1);
			lo++;
		}

		const averaged = {} as Record<K, number | null>;
		for (const key of keys) {
			averaged[key] = counts[key] > 0 ? sums[key] / counts[key] : null;
		}
		result.set(sorted[hi].round, averaged);
	}

	return result;
}
