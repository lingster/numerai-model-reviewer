/**
 * Which of a user's models a page acts on.
 *
 * Picking none means "all of them": an account's models are usually looked at
 * together, and selecting twenty by hand to see a whole account is busywork.
 * The rankings and models pages share this so the two cannot disagree about
 * what an empty selection means.
 */

/** Only the identity both pages rely on; each passes its own richer model type. */
export interface SelectableModel {
	id: string;
	name: string;
}

/** The picked models, or every model of the selected user when none are picked. */
export function effectiveModels<T extends SelectableModel>(
	selected: ReadonlyArray<T>,
	available: ReadonlyArray<T>,
	hasSelectedUser: boolean
): T[] {
	if (selected.length > 0) return [...selected];
	return hasSelectedUser ? [...available] : [];
}

/** True when the fallback above is what supplied the models — for the button's label. */
export function isUsingAllUserModels<T extends SelectableModel>(
	selected: ReadonlyArray<T>,
	effective: ReadonlyArray<T>
): boolean {
	return selected.length === 0 && effective.length > 0;
}
