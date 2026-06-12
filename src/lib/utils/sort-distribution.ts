/**
 * Sorting for the distribution page's model table.
 *
 * Kept as a dependency-free module (like paginate-models.ts) so the table's
 * sort behaviour is unit-testable without mounting the page. Null metric
 * values always sort last regardless of direction, so models with unresolved
 * scores don't float to the top when sorting ascending.
 */
import type { DistributionModelEntry } from "$lib/types.js";

export type DistributionSortKey =
  | "modelName"
  | "corr"
  | "mmc"
  | "score"
  | "rank"
  | "percentile"
  | "stakeValue";

export type SortDirection = "asc" | "desc";

export function sortDistributionModels(
  models: DistributionModelEntry[],
  key: DistributionSortKey,
  direction: SortDirection,
): DistributionModelEntry[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...models].sort((a, b) => {
    if (key === "modelName") {
      return (
        sign *
        a.modelName.localeCompare(b.modelName, undefined, {
          sensitivity: "base",
        })
      );
    }
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sign * (av - bv);
  });
}
