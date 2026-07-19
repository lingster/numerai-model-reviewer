/**
 * Bounded-concurrency map. Runs `worker` over `items` with at most `limit`
 * promises in flight at once, preserving input order in the returned array.
 *
 * Used to parallelise the precompute's per-model / per-batch Numerai API fetches
 * (previously sequential with a fixed sleep between each), turning a multi-hour
 * fleet fetch into minutes. Rate-limit safety lives in graphqlQuery (429 +
 * exponential backoff), so this helper only governs how many run at once.
 *
 * A rejecting worker rejects the whole call (Promise.all semantics); callers
 * that want best-effort behaviour should catch inside their worker.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  const run = async (): Promise<void> => {
    // `next++` is atomic between awaits (single-threaded JS), so each index is
    // claimed by exactly one runner.
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
