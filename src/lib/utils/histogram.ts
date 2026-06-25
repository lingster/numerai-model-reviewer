/**
 * Pure histogram binning for the round-summary distribution chart.
 *
 * Given a list of numeric values, bucket them into `binCount` equal-width bins
 * spanning [min, max]. Non-finite values are ignored. Returned bins are ordered
 * left→right and each carries its [x0, x1) range and count.
 */

export interface HistogramBin {
	/** Inclusive left edge. */
	x0: number;
	/** Exclusive right edge (inclusive for the final bin). */
	x1: number;
	count: number;
}

/**
 * Bucket `values` into `binCount` equal-width bins over their [min, max] range.
 * Returns [] for an empty/all-non-finite input. When every value is identical,
 * a small symmetric pad is added so the single value still yields a valid range.
 */
export function computeHistogram(values: number[], binCount = 30): HistogramBin[] {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0 || binCount < 1) return [];

	let min = Math.min(...finite);
	let max = Math.max(...finite);
	if (min === max) {
		const pad = Math.abs(min) || 1;
		min -= pad / 2;
		max += pad / 2;
	}

	const width = (max - min) / binCount;
	const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
		x0: min + i * width,
		x1: min + (i + 1) * width,
		count: 0
	}));

	for (const v of finite) {
		let idx = Math.floor((v - min) / width);
		if (idx < 0) idx = 0;
		if (idx >= binCount) idx = binCount - 1; // include max in the last bin
		bins[idx].count++;
	}
	return bins;
}

/**
 * Which bin (index) a value falls into for the given bins, using the same edge
 * logic as computeHistogram. Returns -1 for empty bins or non-finite values.
 * Values outside the range clamp to the first/last bin.
 */
export function binIndexOf(value: number, bins: HistogramBin[]): number {
	if (bins.length === 0 || !Number.isFinite(value)) return -1;
	const min = bins[0].x0;
	const width = bins[0].x1 - bins[0].x0 || 1;
	let idx = Math.floor((value - min) / width);
	if (idx < 0) idx = 0;
	if (idx >= bins.length) idx = bins.length - 1;
	return idx;
}
