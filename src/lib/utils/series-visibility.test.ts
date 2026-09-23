import { describe, expect, it } from 'vitest';
import { invertVisibility, setAllVisible } from './series-visibility';

const keys = ['a:staked', 'b:staked', 'b:all'];

describe('setAllVisible', () => {
	it('shows every series', () => {
		expect(setAllVisible(keys, true)).toEqual({ 'a:staked': true, 'b:staked': true, 'b:all': true });
	});

	it('hides every series', () => {
		expect(setAllVisible(keys, false)).toEqual({ 'a:staked': false, 'b:staked': false, 'b:all': false });
	});

	it('drops series that are no longer plotted', () => {
		expect(Object.keys(setAllVisible(['a:staked'], true))).toEqual(['a:staked']);
	});
});

describe('invertVisibility', () => {
	it('swaps shown and hidden', () => {
		const current = { 'a:staked': true, 'b:staked': false, 'b:all': true };
		expect(invertVisibility(keys, current)).toEqual({
			'a:staked': false,
			'b:staked': true,
			'b:all': false
		});
	});

	it('treats a series with no entry yet as visible, so inverting hides it', () => {
		// New series default to visible when they appear, so the inverse is hidden.
		expect(invertVisibility(['new:staked'], {})).toEqual({ 'new:staked': false });
	});
});
