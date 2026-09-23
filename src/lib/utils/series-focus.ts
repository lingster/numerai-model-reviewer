/**
 * Focusing one model in a chart of many.
 *
 * Clicking a point singles that model out: it keeps its colour while every
 * other line is drawn in grey, so the one being studied reads against the rest
 * without losing them as context. Clicking it again restores exactly what was
 * on screen before — including models that were hidden then.
 */

/** Grey for the models that are not focused: visible, but clearly secondary. */
export const MUTED_SERIES_COLOR = '#9ca3af';

/** The focus after clicking `modelId`: focus it, or clear it if it already had focus. */
export function toggleFocus(focused: string | null, modelId: string): string | null {
	return focused === modelId ? null : modelId;
}

/** A series' colour under the current focus — its own, or muted. */
export function focusedSeriesColor(
	color: string,
	modelId: string,
	focused: string | null
): string {
	if (focused === null || focused === modelId) return color;
	return MUTED_SERIES_COLOR;
}

/**
 * The same series, with the focused one last.
 *
 * SVG paints in document order, so a focused line drawn early is overdrawn by
 * the greyed ones wherever they cross — exactly where the line matters most.
 * Relative order is otherwise untouched, so colours (assigned by position)
 * do not shuffle.
 */
export function orderForFocus<T>(
	series: ReadonlyArray<T>,
	focused: string | null,
	idOf: (item: T) => string
): T[] {
	if (focused === null) return [...series];
	const rest = series.filter((item) => idOf(item) !== focused);
	if (rest.length === series.length) return [...series]; // focus is not plotted
	return [...rest, ...series.filter((item) => idOf(item) === focused)];
}
