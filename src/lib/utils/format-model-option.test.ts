import { describe, it, expect } from 'vitest';
import { formatModelOption } from './format-model-option.js';
import type { NumeraiModel } from '$lib/types.js';

const base: NumeraiModel = { id: '1', name: 'bgda_51_auto', username: 'bguberfain', tournament: 8 };

describe('formatModelOption', () => {
	it('shows name and owner when stake/return are absent', () => {
		expect(formatModelOption(base)).toBe('bgda_51_auto (bguberfain)');
	});

	it('appends stake (rounded, with thousands separators) and signed 1y return', () => {
		expect(formatModelOption({ ...base, stake: 339.115, return1y: 106.608 })).toBe(
			'bgda_51_auto (bguberfain) · 339 NMR · +106.6% 1y'
		);
	});

	it('shows small stakes with two decimals', () => {
		expect(formatModelOption({ ...base, stake: 0.012, return1y: null })).toBe(
			'bgda_51_auto (bguberfain) · 0.01 NMR'
		);
	});

	it('omits zero or null values', () => {
		expect(formatModelOption({ ...base, stake: 0, return1y: 0 })).toBe('bgda_51_auto (bguberfain)');
		expect(formatModelOption({ ...base, stake: null, return1y: null })).toBe(
			'bgda_51_auto (bguberfain)'
		);
	});

	it('renders negative returns with a minus sign', () => {
		expect(formatModelOption({ ...base, stake: 50, return1y: -16.52 })).toBe(
			'bgda_51_auto (bguberfain) · 50 NMR · -16.5% 1y'
		);
	});

	it('adds thousands separators for large stakes', () => {
		expect(formatModelOption({ ...base, stake: 3014.36, return1y: null })).toBe(
			'bgda_51_auto (bguberfain) · 3,014 NMR'
		);
	});
});
