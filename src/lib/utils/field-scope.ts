/**
 * Field-scope helpers shared by the rankings API client and its chart.
 *
 * `FieldScope` is which competitors a round's rank is measured against: the
 * staked field (what payouts use) or every model that scored that round — the
 * Worker's `fieldScope` query param. `FieldScopeSelection` is the UI-level
 * choice, which adds 'both': request and plot both fields at once so a model
 * can be compared against each.
 */

export type FieldScope = 'staked' | 'all';
export type FieldScopeSelection = FieldScope | 'both';

/** Default selection: rank against the staked field (what payouts use). */
export const DEFAULT_FIELD_SCOPE: FieldScopeSelection = 'staked';

/**
 * Concrete field scopes to fetch for a UI selection. 'both' fetches each field
 * once per model — callers should batch per (model, scope) pair rather than
 * multiplying the whole model batch size by 2 at once.
 */
export function resolveFieldScopes(selection: FieldScopeSelection): FieldScope[] {
	return selection === 'both' ? ['staked', 'all'] : [selection];
}

/**
 * Single scope to use for views that can only show one field at a time (e.g.
 * the per-round models table). 'both' falls back to 'staked', the
 * payout-relevant field, since that's what the table showed before this toggle
 * existed.
 */
export function resolvePrimaryFieldScope(selection: FieldScopeSelection): FieldScope {
	return selection === 'all' ? 'all' : 'staked';
}

/**
 * Human label for a field scope. totalModels differs between 'staked' and
 * 'all', so every rank display that can show either scope must say which one
 * it is — this is the single source for that text.
 */
export function fieldScopeLabel(scope: FieldScope): string {
	return scope === 'staked' ? 'Staked field' : 'All models';
}
