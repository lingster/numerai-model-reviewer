/**
 * Bulk visibility changes for the ranking-history chart's series.
 *
 * A series is one plotted line, keyed by model and field scope (a model ranked
 * against both fields has two). With dozens of models on the page, picking a
 * handful means clicking the rest off one by one — so the chart offers all,
 * none and invert. Both helpers return a record covering exactly `keys`, so a
 * series that is no longer plotted cannot linger in the state.
 */

export type SeriesVisibility = Record<string, boolean>;

/** Every series shown (`visible` true) or hidden. */
export function setAllVisible(keys: ReadonlyArray<string>, visible: boolean): SeriesVisibility {
	return Object.fromEntries(keys.map((key) => [key, visible]));
}

/**
 * Shown becomes hidden and vice versa. A series with no entry yet counts as
 * visible, which is how the chart treats a newly plotted one.
 */
export function invertVisibility(
	keys: ReadonlyArray<string>,
	current: Readonly<SeriesVisibility>
): SeriesVisibility {
	return Object.fromEntries(keys.map((key) => [key, !(current[key] ?? true)]));
}
