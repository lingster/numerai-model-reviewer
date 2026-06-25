import { describe, expect, it } from 'vitest';
import { binIndexOf, computeHistogram } from './histogram.js';

describe('computeHistogram', () => {
	it('returns [] for empty input', () => {
		expect(computeHistogram([])).toEqual([]);
	});

	it('ignores non-finite values', () => {
		const bins = computeHistogram([NaN, Infinity, -Infinity], 4);
		expect(bins).toEqual([]);
	});

	it('buckets values into equal-width bins and counts them', () => {
		const bins = computeHistogram([0, 1, 2, 3, 4], 4);
		expect(bins).toHaveLength(4);
		// total count is preserved
		expect(bins.reduce((s, b) => s + b.count, 0)).toBe(5);
		// edges span [0, 4]
		expect(bins[0].x0).toBeCloseTo(0, 10);
		expect(bins[bins.length - 1].x1).toBeCloseTo(4, 10);
	});

	it('includes the max value in the final bin (not a phantom extra bin)', () => {
		const bins = computeHistogram([0, 10], 5);
		expect(bins).toHaveLength(5);
		expect(bins[bins.length - 1].count).toBeGreaterThanOrEqual(1);
		expect(bins.reduce((s, b) => s + b.count, 0)).toBe(2);
	});

	it('handles all-identical values with a padded range', () => {
		const bins = computeHistogram([0.02, 0.02, 0.02], 10);
		expect(bins).toHaveLength(10);
		expect(bins.reduce((s, b) => s + b.count, 0)).toBe(3);
		expect(bins[0].x0).toBeLessThan(0.02);
		expect(bins[bins.length - 1].x1).toBeGreaterThan(0.02);
	});

	it('returns [] when binCount < 1', () => {
		expect(computeHistogram([1, 2, 3], 0)).toEqual([]);
	});
});

describe('binIndexOf', () => {
	const bins = computeHistogram([0, 10], 5); // 5 bins of width 2 over [0,10]

	it('maps values to the bin produced by computeHistogram', () => {
		expect(binIndexOf(0, bins)).toBe(0);
		expect(binIndexOf(3, bins)).toBe(1);
		expect(binIndexOf(10, bins)).toBe(4); // max clamps into last bin
	});

	it('clamps out-of-range values to the edge bins', () => {
		expect(binIndexOf(-100, bins)).toBe(0);
		expect(binIndexOf(100, bins)).toBe(4);
	});

	it('returns -1 for empty bins or non-finite values', () => {
		expect(binIndexOf(1, [])).toBe(-1);
		expect(binIndexOf(NaN, bins)).toBe(-1);
	});

	it('agrees with computeHistogram counts (reconstructs the histogram)', () => {
		const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const h = computeHistogram(values, 5);
		const recount = new Array(h.length).fill(0);
		for (const v of values) recount[binIndexOf(v, h)]++;
		expect(recount).toEqual(h.map((b) => b.count));
	});
});
