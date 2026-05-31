/**
 * Client-side filter + pagination for the per-round staked-model table.
 *
 * The rankings page fetches the full ranked field for a round and lets the user
 * search by model name and page through it (so they can find their own model,
 * not just the top N). This pure helper keeps that logic testable and out of
 * the component.
 */
import type { RoundModelScore } from '$lib/types.js';

export interface PaginatedModels {
	/** The models on the requested (clamped) page. */
	items: RoundModelScore[];
	/** Total models matching the query (across all pages). */
	totalFiltered: number;
	/** Number of pages for the filtered set (always >= 1). */
	totalPages: number;
	/** The page actually used after clamping into [1, totalPages]. */
	page: number;
}

/**
 * Filter `models` by a case-insensitive substring of the model name, then
 * return the slice for `page` (1-based). `page` is clamped into range so callers
 * never have to guard against stale/out-of-range page numbers.
 */
export function paginateModels(
	models: RoundModelScore[],
	query: string,
	page: number,
	pageSize: number
): PaginatedModels {
	const needle = query.trim().toLowerCase();
	const filtered = needle
		? models.filter((m) => m.modelName.toLowerCase().includes(needle))
		: models;

	const totalFiltered = filtered.length;
	const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
	const clampedPage = Math.min(Math.max(1, Math.trunc(page)), totalPages);

	const start = (clampedPage - 1) * pageSize;
	const items = filtered.slice(start, start + pageSize);

	return { items, totalFiltered, totalPages, page: clampedPage };
}
