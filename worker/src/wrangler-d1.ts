/**
 * Helpers for driving D1 through the wrangler CLI, which is how precompute
 * reaches the remote database from GitHub Actions.
 *
 * The shell is injected (CommandRunner) rather than imported, so this module
 * has no Node dependency and every path is unit-testable.
 */

import type { D1Query } from './d1-query';

/**
 * Runs a shell command and returns its stdout, throwing on a non-zero exit the
 * way execSync does (with the output attached as `stderr`/`stdout`).
 */
export type CommandRunner = (command: string) => string;

/** Child-process output: a string, or a Buffer when no encoding was requested. */
type ProcessOutput = string | { toString(): string } | null | undefined;

/** The text of a failed child process, as thrown by execSync. */
interface ExecFailure {
	message?: string;
	stderr?: ProcessOutput;
	stdout?: ProcessOutput;
}

const asText = (value: ProcessOutput): string =>
	value === null || value === undefined ? '' : value.toString().trim();

/**
 * Why a wrangler command failed. execSync's own message is only
 * "Command failed: <cmd>"; wrangler's actual reason — a quota limit, a timeout —
 * is on stderr (or occasionally stdout), so that is preferred when present.
 */
export function execErrorDetail(error: unknown): string {
	if (typeof error !== 'object' || error === null) return String(error);

	const failure = error as ExecFailure;
	const output = [asText(failure.stderr), asText(failure.stdout)].filter(Boolean).join('\n');
	return output || failure.message || String(error);
}

/**
 * The result rows from `wrangler d1 execute --json`, which prints an array of
 * per-statement results (or, in some versions, a single result object).
 * Throws when there is no results array: an unreadable result must not be
 * mistaken for an empty one.
 */
export function parseWranglerJsonRows(output: string): Array<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(output);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	const results = (first as { results?: unknown } | undefined)?.results;

	if (!Array.isArray(results)) {
		throw new Error(`wrangler returned no results array: ${output.slice(0, 200)}`);
	}
	return results as Array<Record<string, unknown>>;
}

/**
 * A D1Query backed by `wrangler d1 execute`, against the local or remote DB.
 * Failures reject with wrangler's own explanation, not execSync's generic one.
 */
export function createWranglerQuery(
	run: CommandRunner,
	isLocal: boolean,
	database = 'numerai-cache'
): D1Query {
	const location = isLocal ? '--local' : '--remote';

	return async (sql) => {
		let output: string;
		try {
			output = run(
				`wrangler d1 execute ${database} ${location} --yes --json --command ${JSON.stringify(sql)}`
			);
		} catch (error) {
			throw new Error(execErrorDetail(error), { cause: error });
		}
		return parseWranglerJsonRows(output);
	};
}
