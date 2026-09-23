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
