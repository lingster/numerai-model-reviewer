/**
 * Sorting for the Round Summary "your models" table. Columns map either to a
 * metric (via metricValue) or to the model name / rank. Null metric values
 * always sort last regardless of direction, so missing data never jumps to top.
 */
import type { RoundModelScore } from '$lib/types.js';
import { metricValue, type RoundSummaryMetric } from './round-summary-metric.js';

export type SortKey = 'model' | RoundSummaryMetric | 'rank';
export type SortDir = 'asc' | 'desc';

function comparable(m: RoundModelScore, key: SortKey): number | string | null {
	if (key === 'model') return m.modelName.toLowerCase();
	if (key === 'rank') return m.rank;
	return metricValue(m, key);
}

/** Return a new array of `models` sorted by `key`/`dir`; nulls always last. */
export function sortRoundModels(
	models: RoundModelScore[],
	key: SortKey,
	dir: SortDir
): RoundModelScore[] {
	const sign = dir === 'asc' ? 1 : -1;
	return [...models].sort((a, b) => {
		const av = comparable(a, key);
		const bv = comparable(b, key);
		if (av === null && bv === null) return 0;
		if (av === null) return 1; // a after b
		if (bv === null) return -1; // b after a
		if (typeof av === 'string' && typeof bv === 'string') return sign * av.localeCompare(bv);
		return sign * ((av as number) - (bv as number));
	});
}

/** Default direction when a column is first clicked: text/rank asc, metrics desc. */
export function defaultDirFor(key: SortKey): SortDir {
	return key === 'model' || key === 'rank' ? 'asc' : 'desc';
}
