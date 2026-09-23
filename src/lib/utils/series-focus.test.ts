import { describe, expect, it } from 'vitest';
import { MUTED_SERIES_COLOR, focusedSeriesColor, toggleFocus } from './series-focus';

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
