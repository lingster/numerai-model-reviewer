import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RANKING_DISPLAY_MODE,
	formatPercentile,
	rankDisplayValue,
	rankToPercentile
} from './ranking-display.js';

describe('rankToPercentile', () => {
	it('maps the best rank (1) to 100', () => {
		expect(rankToPercentile(1, 200)).toBeCloseTo(100, 10);
	});

	it('maps the worst rank (N) to 100/N (small but positive, never 0)', () => {
		expect(rankToPercentile(200, 200)).toBeCloseTo(0.5, 10);
	});

	it('places the middle rank near 50', () => {
		// rank 100 of 200 -> (200-100+1)/200*100 = 50.5
		expect(rankToPercentile(100, 200)).toBeCloseTo(50.5, 10);
	});

	it('returns 100 for a single-model field without dividing by zero', () => {
		expect(rankToPercentile(1, 1)).toBeCloseTo(100, 10);
	});

	it('returns null when rank is missing', () => {
		expect(rankToPercentile(null, 200)).toBeNull();
	});

	it('returns null when the field is empty or non-positive', () => {
		expect(rankToPercentile(1, 0)).toBeNull();
		expect(rankToPercentile(1, -5)).toBeNull();
	});
});

describe('rankDisplayValue', () => {
	it('returns the raw rank in rank mode', () => {
		expect(rankDisplayValue(7, 200, 'rank')).toBe(7);
		expect(rankDisplayValue(null, 200, 'rank')).toBeNull();
	});

	it('returns the percentile in percentile mode', () => {
		expect(rankDisplayValue(1, 200, 'percentile')).toBeCloseTo(100, 10);
	});
});

describe('formatPercentile', () => {
	it('formats to one decimal place', () => {
		expect(formatPercentile(87.5)).toBe('87.5');
		expect(formatPercentile(100)).toBe('100.0');
	});
});

describe('DEFAULT_RANKING_DISPLAY_MODE', () => {
	it("defaults to 'rank' (today's behaviour)", () => {
		expect(DEFAULT_RANKING_DISPLAY_MODE).toBe('rank');
	});
});
