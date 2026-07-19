/**
 * Retry a D1 operation on transient "database is locked" / SQLITE_BUSY errors.
 *
 * D1 — and the miniflare local SQLite the CI integration tests run against —
 * can transiently reject overlapping access with SQLITE_BUSY ("database is
 * locked") when several requests touch the same database at once. These errors
 * are safe to retry: the statement never partially applied, so read paths and
 * idempotent single-statement writes (INSERT OR REPLACE, DELETE) both tolerate
 * a re-run. Non-transient errors propagate immediately.
 *
 * Without this the test suite intermittently fails: vitest runs its files in
 * parallel, so multiple requests hit the one local worker's D1 simultaneously.
 */
export async function d1Retry<T>(op: () => Promise<T>, attempts = 6): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (attempt === attempts - 1 || !isTransientD1Error(err)) throw err;
			lastError = err;
			// Exponential backoff with jitter: ~10, 20, 40, 80, 160 ms.
			const base = 10 * 2 ** attempt;
			await sleep(base + Math.floor(Math.random() * base));
		}
	}
	// Unreachable — the final iteration always returns or throws — but keeps the
	// type checker satisfied that every path produces a value.
	throw lastError;
}

/** True for D1/SQLite errors that are safe to retry (lock contention only). */
function isTransientD1Error(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /database is locked|SQLITE_BUSY/i.test(msg);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
