import { describe, expect, it } from 'vitest';
import { MUTED_SERIES_COLOR, focusedSeriesColor, orderForFocus, toggleFocus } from './series-focus';

describe('toggleFocus', () => {
	it('focuses the model that was clicked', () => {
		expect(toggleFocus(null, 'a')).toBe('a');
	});

	it('clears the focus when the focused model is clicked again', () => {
		expect(toggleFocus('a', 'a')).toBeNull();
	});

	it('moves the focus straight to another model', () => {
		// Clicking a second model should not need an unfocus click first.
		expect(toggleFocus('a', 'b')).toBe('b');
	});
});

describe('focusedSeriesColor', () => {
	const colour = '#ff0000';

	it('leaves every colour alone when nothing is focused', () => {
		expect(focusedSeriesColor(colour, 'a', null)).toBe(colour);
	});

	it('keeps the focused model its own colour', () => {
		expect(focusedSeriesColor(colour, 'a', 'a')).toBe(colour);
	});

	it('mutes the others so the focused line reads against them', () => {
		expect(focusedSeriesColor(colour, 'b', 'a')).toBe(MUTED_SERIES_COLOR);
	});
});

describe('orderForFocus', () => {
	const series = [{ modelId: 'a' }, { modelId: 'b' }, { modelId: 'c' }];

	it('leaves the order alone when nothing is focused', () => {
		expect(orderForFocus(series, null, (s) => s.modelId)).toEqual(series);
	});

	it('draws the focused model last, so nothing overdraws it', () => {
		// SVG paints in document order: a focused line drawn first disappears
		// under the greyed ones wherever they cross.
		expect(orderForFocus(series, 'a', (s) => s.modelId).map((s) => s.modelId)).toEqual(['b', 'c', 'a']);
	});

	it('keeps every series, in their original relative order', () => {
		expect(orderForFocus(series, 'b', (s) => s.modelId).map((s) => s.modelId)).toEqual(['a', 'c', 'b']);
	});

	it('handles a focus on a model that is not plotted', () => {
		expect(orderForFocus(series, 'gone', (s) => s.modelId)).toEqual(series);
	});
});
