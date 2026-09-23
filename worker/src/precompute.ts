/**
 * Precompute Rankings Script
 *
 * Standalone script that fetches top staked models and their performance data
 * from the Numerai API and stores it in D1.
 *
 * Usage:
 *   npm run precompute:dev                    -- uses defaults from precompute.config.yaml
 *   npm run precompute:dev -- --top-n 100     -- override top N models
 *   npm run precompute:dev -- --users alice,bob  -- include specific users
 *   npm run precompute:dev -- --models m1,m2  -- include specific models
 *   npm run precompute:prod                   -- populates remote D1
 *   npm run precompute:prod -- --no-cache     -- bypass CSV cache, force fresh API fetch
 *
 * The self-hosted server runs the same pipeline against its SQLite file through
 * server/src/precompute-sqlite.ts; this entry point writes to D1 via wrangler.
 */

import { readMaxRound } from './refresh-floor';
import { refreshCoverage, type RoundSpan } from './tournament-coverage';
import { encodeFieldMetrics, FIELD_SCOPES, type FieldScope } from './round-field';
import { METRIC_SETS, type MetricSet } from './ranking';
import {
  fieldFromRows,
  readStoredRounds,
  roundsToBackfill,
  upsertRoundFieldSql,
  type FieldRow
} from './round-field-store';
import type { D1Query } from './d1-query';
import type { PrecomputeTarget, SqlWriter } from './precompute-target';
import { createWranglerQuery, execErrorDetail, type CommandRunner } from './wrangler-d1';
import { execFileSync, execSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { mapWithConcurrency } from './concurrency';

const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

// Overridable because the self-hosted container's filesystem is read-only.
const CACHE_DIR = process.env.PRECOMPUTE_CACHE_DIR || join(process.cwd(), '.cache');
const CACHE_TOP_MODELS = join(CACHE_DIR, 'top_models.csv');
const CACHE_PERFORMANCES = join(CACHE_DIR, 'performances.csv');
const CACHE_META = join(CACHE_DIR, 'meta.json');

// --- Config types ---

interface PrecomputeConfig {
  tournament: number;
  topN: number;
  /** Older rounds to build stored fields for per run (see Step 7). */
  backfillRounds: number;
  /** Already-stored rounds to re-fetch and rewrite (see --refresh-overlap below). */
  refreshOverlapRounds: number;
  /** Capture Classic models with no stake (see keepsLeaderboardEntry). */
  includeUnstaked: boolean;
  batchSize: number;
  rateLimitMs: number;
  concurrency: number;
  users: string[];
  models: string[];
}

const DEFAULT_CONFIG: PrecomputeConfig = {
  // 100 rounds a run keeps the backfill's reads a small share of D1's free daily
  // budget while covering ~2,900 rounds of history in about a month.
  backfillRounds: 100,
  refreshOverlapRounds: 0,
  // Off by default: the D1 runs in GitHub Actions cannot afford ~11k more
  // models. The self-hosted scheduler turns it on.
  includeUnstaked: false,
  tournament: 8,
  topN: 10000,
  // Max batchSize is 3 — higher values exceed the Numerai API rate limit
  batchSize: 3,
  rateLimitMs: 1000,
  // Number of Numerai API requests in flight at once for the per-model/per-batch
  // performance fetches. graphqlQuery backs off on 429, so this can be raised to
  // trade throughput against rate-limit pushback. Replaces the old sequential
  // rateLimitMs sleep for those loops (rateLimitMs still paces the paged
  // leaderboard/account scans).
  //
  // Tuned empirically against the live API (Jul 2026): both the crypto
  // single-model query and the heavier 3-alias profile query saturate at ~20
  // (a latency floor, not rate limiting — 0×429 observed up to 24). 16 keeps
  // ~80% of peak with headroom for sustained runs; raise via --concurrency if
  // the logs show no "Rate limited, retrying" lines.
  concurrency: 16,
  users: [],
  models: []
};

// --- Config loading ---

function loadYamlConfig(): Partial<PrecomputeConfig> {
  const configPaths = [
    join(process.cwd(), 'precompute.config.yaml'),
    join(process.cwd(), 'precompute.config.yml')
  ];

  for (const configPath of configPaths) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(content);
      console.log(`Loaded config from ${configPath}`);
      return {
        tournament: parsed.tournament,
        topN: parsed.topN,
        backfillRounds: parsed.backfillRounds,
        refreshOverlapRounds: parsed.refreshOverlapRounds,
        includeUnstaked: parsed.includeUnstaked,
        batchSize: parsed.batchSize,
        rateLimitMs: parsed.rateLimitMs,
        concurrency: parsed.concurrency,
        users: Array.isArray(parsed.users) ? parsed.users.filter(Boolean) : [],
        models: Array.isArray(parsed.models) ? parsed.models.filter(Boolean) : []
      };
    } catch {
      // File not found or parse error, try next
    }
  }

  console.log('No config file found, using defaults');
  return {};
}

function parseCliArgs(): { isLocal: boolean; noCache: boolean; reset: boolean; overrides: Partial<PrecomputeConfig> } {
  const args = process.argv.slice(2);
  const isLocal = args.includes('--local');
  const noCache = args.includes('--no-cache');
  // --reset clears the tournament's existing rows before writing. Off by default:
  // normal runs upsert (INSERT OR REPLACE on the PK), so resolved history is
  // rewritten harmlessly and new rounds/models are appended — no bulk DELETE.
  // Use --reset only for one-off migrations (e.g. changing the model source).
  const reset = args.includes('--reset');
  const includeUnstaked = args.includes('--include-unstaked') ? true : undefined;
  const overrides: Partial<PrecomputeConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--top-n':
        if (next) { overrides.topN = parseInt(next, 10); i++; }
        break;
      case '--backfill-rounds':
        if (next) { overrides.backfillRounds = parseInt(next, 10); i++; }
        break;
      case '--refresh-overlap':
        if (next) { overrides.refreshOverlapRounds = parseInt(next, 10); i++; }
        break;
      case '--tournament':
        if (next) { overrides.tournament = parseInt(next, 10); i++; }
        break;
      case '--users':
        if (next) { overrides.users = next.split(',').map((s: string) => s.trim()).filter(Boolean); i++; }
        break;
      case '--models':
        if (next) { overrides.models = next.split(',').map((s: string) => s.trim()).filter(Boolean); i++; }
        break;
      case '--batch-size':
        if (next) { overrides.batchSize = parseInt(next, 10); i++; }
        break;
      case '--rate-limit':
        if (next) { overrides.rateLimitMs = parseInt(next, 10); i++; }
        break;
      case '--concurrency':
        if (next) { overrides.concurrency = parseInt(next, 10); i++; }
        break;
    }
  }

  if (includeUnstaked !== undefined) overrides.includeUnstaked = includeUnstaked;
  return { isLocal, noCache, reset, overrides };
}

/** Drop keys whose value is undefined so a missing yaml/cli field can't clobber
 * a default when spread (loadYamlConfig lists every key, so an omitted one comes
 * through as `undefined`). */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

function buildConfig(): { config: PrecomputeConfig; isLocal: boolean; noCache: boolean; reset: boolean } {
  const yamlConfig = loadYamlConfig();
  const { isLocal, noCache, reset, overrides } = parseCliArgs();

  // Merge: defaults < yaml < cli args
  const config: PrecomputeConfig = {
    ...DEFAULT_CONFIG,
    ...stripUndefined(yamlConfig),
    ...stripUndefined(overrides),
    // Merge arrays: yaml users + cli users (deduplicated)
    users: [...new Set([
      ...(yamlConfig.users ?? []),
      ...(overrides.users ?? [])
    ])],
    models: [...new Set([
      ...(yamlConfig.models ?? []),
      ...(overrides.models ?? [])
    ])]
  };

  return { config, isLocal, noCache, reset };
}

// --- API helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// --- Retry / backoff ---

const MAX_RETRIES = 5;
/** Initial backoff when the server gives no Retry-After (then doubles). */
export const RETRY_BASE_MS = 30_000;
/** Ceiling for a single wait, so one request can't stall the run indefinitely. */
export const RETRY_CAP_MS = 300_000;
/** Upper bound of random jitter added to every backoff, to de-sync concurrent retries. */
export const RETRY_JITTER_MS = 1_000;

/**
 * Parse an HTTP `Retry-After` value into milliseconds from now. Accepts both
 * forms the spec allows: delta-seconds ("120") and an HTTP-date. Returns null
 * when absent or unparseable (caller then falls back to exponential backoff).
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(0, parseInt(trimmed, 10) * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

/**
 * Backoff for a retry attempt, excluding jitter. When the server supplied a
 * Retry-After (retryAfterMs != null) we respect it; otherwise back off
 * exponentially from baseMs (30s, 60s, 120s, ...). Both are capped at capMs.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  baseMs = RETRY_BASE_MS,
  capMs = RETRY_CAP_MS
): number {
  if (retryAfterMs !== null) return Math.min(capMs, retryAfterMs);
  return Math.min(capMs, baseMs * Math.pow(2, attempt));
}

/** computeBackoffMs plus a small random jitter (0..RETRY_JITTER_MS). */
function backoffWithJitter(attempt: number, retryAfterMs: number | null): number {
  return computeBackoffMs(attempt, retryAfterMs) + Math.floor(Math.random() * RETRY_JITTER_MS);
}

async function graphqlQuery<T>(queryStr: string, variables?: Record<string, unknown>): Promise<T> {
  let lastError: Error = new Error('Max retries exceeded');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(NUMERAI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryStr, variables })
      });
    } catch (networkError) {
      // Transport failures (DNS, connection reset, TLS) are transient — retry.
      lastError = networkError instanceof Error ? networkError : new Error(String(networkError));
      if (attempt < MAX_RETRIES) {
        const delay = backoffWithJitter(attempt, null);
        console.log(`  Network error (${lastError.message}), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      // 429 (rate limit) and 5xx (server) are transient; other 4xx are not.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfterMs =
          response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after'), Date.now()) : null;
        const delay = backoffWithJitter(attempt, retryAfterMs);
        const reason = response.status === 429 ? 'Rate limited' : `Server error ${response.status}`;
        const src = retryAfterMs !== null ? ' [Retry-After]' : '';
        console.log(`  ${reason}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})${src}...`);
        await sleep(delay);
        continue;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }

    const result: GraphQLResponse<T> = await response.json() as GraphQLResponse<T>;
    if (result.errors?.length) {
      // Body-level rate limit (HTTP 200 + error message) — no header available,
      // so fall back to exponential backoff.
      const isRateLimit = result.errors.some(e => e.message.toLowerCase().includes('rate limit'));
      if (isRateLimit && attempt < MAX_RETRIES) {
        const delay = backoffWithJitter(attempt, null);
        console.log(`  Rate limited (body), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
        continue;
      }
      throw new Error(result.errors.map(e => e.message).join(', '));
    }
    if (!result.data) {
      throw new Error('No data returned from API');
    }
    return result.data;
  }
  throw lastError;
}

async function getCurrentRound(tournament: number): Promise<number> {
  const result = await graphqlQuery<{ rounds: Array<{ number: number }> }>(
    `query($tournament: Int!) { rounds(tournament: $tournament, limit: 1) { number } }`,
    { tournament }
  );
  return result.rounds[0].number;
}

// --- Data fetching ---

/**
 * Build a model-name → owning-account map for a tournament by enumerating its
 * accountLeaderboard accounts and reading each account's models. Used for Crypto,
 * whose model-level leaderboard (and per-round performance query) exposes only
 * the model name, so the table's owner column would otherwise duplicate it.
 * Classic/Signals get the account directly from their profile fetches.
 */
async function fetchModelAccountMap(
  tournament: number,
  batchSize: number,
  rateLimitMs: number,
  concurrency: number
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  // 1. Collect account usernames from the (account-level) leaderboard. Paging is
  // sequential (offset depends on the previous page) and short, so keep the
  // rateLimitMs pacing here.
  const accounts: string[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const res = await graphqlQuery<{ accountLeaderboard: Array<{ username: string }> }>(
      `query($limit: Int!, $offset: Int!, $tournament: Int!) {
        accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) { username }
      }`,
      { limit: pageSize, offset, tournament }
    );
    const batch = res.accountLeaderboard ?? [];
    if (batch.length === 0) break;
    for (const a of batch) if (a.username) accounts.push(a.username);
    offset += pageSize;
    await sleep(rateLimitMs);
    if (batch.length < pageSize) break;
  }

  // 2. Read each account's models for this tournament and invert to model→account.
  // Fan the aliased-account-profile batches out concurrently (this pass was the
  // fixed per-crypto-run cost; graphqlQuery handles 429 backoff).
  const acctBatches: string[][] = [];
  for (let i = 0; i < accounts.length; i += batchSize) {
    acctBatches.push(accounts.slice(i, i + batchSize));
  }
  let processed = 0;
  let lastLogged = 0;
  await mapWithConcurrency(acctBatches, concurrency, async (batch, batchIdx) => {
    const aliases = batch.map(
      (username, idx) =>
        `a${idx}: accountProfile(username: ${JSON.stringify(username)}, tournament: ${tournament}) {
          username models { displayName }
        }`
    );
    try {
      const data = await graphqlQuery<
        Record<string, { username: string; models: Array<{ displayName: string }> | null } | null>
      >(`query { ${aliases.join('\n')} }`);
      for (let idx = 0; idx < batch.length; idx++) {
        const profile = data[`a${idx}`];
        if (!profile?.models) continue;
        for (const m of profile.models) {
          map.set(m.displayName.toLowerCase(), profile.username);
        }
      }
    } catch (error) {
      console.error(`  Error building account map (batch ${batchIdx}):`, error instanceof Error ? error.message : error);
    }
    processed += batch.length;
    if (processed - lastLogged >= 300 || processed >= accounts.length) {
      lastLogged = processed;
      console.log(`  Resolved account models for ${processed}/${accounts.length} accounts...`);
    }
  });

  return map;
}

/**
 * Whether a leaderboard entry joins the fleet precompute fetches.
 *
 * Signals and Crypto take their leaderboards as-is. Classic's v2Leaderboard is
 * ordered by rank and lists ~15k models, ~11k of them unstaked; those were
 * skipped to bound D1's rows. A model that is not in the fleet has no stored
 * rows at all, so ranking it costs a live Numerai fetch per request — which is
 * why the self-hosted runs include them.
 */
export function keepsLeaderboardEntry(
  stake: number,
  tournament: number,
  includeUnstaked: boolean
): boolean {
  const isClassic = tournament !== SIGNALS_TOURNAMENT && tournament !== CRYPTO_TOURNAMENT;
  return !isClassic || includeUnstaked || stake > 0;
}

async function fetchTopStakedModels(
  tournament: number,
  limit: number,
  rateLimitMs: number,
  includeUnstaked = false
): Promise<Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>> {
  const models: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }> = [];
  const batchSize = 500;
  let offset = 0;
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const isCrypto = tournament === CRYPTO_TOURNAMENT;

  // All three leaderboards are model-level (one row per model, with the model's
  // own stake), so secondary staked models are captured:
  //   Classic: v2Leaderboard, Signals: signalsLeaderboard, Crypto: cryptosignalsLeaderboard.
  // Which entries are kept — see keepsLeaderboardEntry.
  const leaderboardField = isSignals
    ? 'signalsLeaderboard'
    : isCrypto
      ? 'cryptosignalsLeaderboard'
      : 'v2Leaderboard';

  while (models.length < limit) {
    const queryStr = `query($limit: Int!, $offset: Int!) {
      ${leaderboardField}(limit: $limit, offset: $offset) { id username nmrStaked }
    }`;
    const result = await graphqlQuery<Record<string, Array<{ id: string; username: string; nmrStaked: string | null }>>>(
      queryStr,
      { limit: batchSize, offset }
    );

    const batch = result[leaderboardField] ?? [];
    if (batch.length === 0) break;

    for (const entry of batch) {
      if (models.length >= limit) break;
      const stake = entry.nmrStaked ? parseFloat(entry.nmrStaked) : 0;
      if (!keepsLeaderboardEntry(stake, tournament, includeUnstaked)) continue;
      models.push({
        modelId: entry.id,
        modelName: entry.username, // username IS the model name on these leaderboards
        username: entry.username, // backfilled to the owning account during the perf fetch
        stakeValue: stake
      });
    }

    console.log(`  Fetched ${models.length}/${limit} staked models (scanned ${offset + batch.length})...`);
    offset += batchSize;
    await sleep(rateLimitMs);
    if (batch.length < batchSize) break;
  }

  return models.slice(0, limit);
}

/**
 * Fetch models for specific user accounts
 * Returns the model names belonging to those accounts
 */
async function fetchUserModels(
  usernames: string[],
  tournament: number,
  rateLimitMs: number
): Promise<Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>> {
  const models: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }> = [];

  for (const username of usernames) {
    try {
      const result = await graphqlQuery<{
        v3UserProfile: {
          id: string;
          username: string;
          accountName: string;
          stakeValue: number | null;
        } | null;
      }>(
        `query($modelName: String!) {
          v3UserProfile(modelName: $modelName) {
            id username accountName
            stakeValue
          }
        }`,
        { modelName: username }
      );

      if (result.v3UserProfile) {
        models.push({
          modelId: result.v3UserProfile.id,
          modelName: result.v3UserProfile.username,
          username: result.v3UserProfile.accountName,
          stakeValue: result.v3UserProfile.stakeValue ?? 0
        });
      }
      await sleep(rateLimitMs);
    } catch (error) {
      console.error(`  Warning: Could not fetch user "${username}":`, error instanceof Error ? error.message : error);
    }
  }

  return models;
}

export type PerformanceRound = {
  roundNumber: number;
  corr: number | null;
  mmc: number | null;
  tc: number | null;
  // Signals' neutral pair (neutral correlation / neutral contribution), which
  // Numerai pays on from rounds opening 2026-09-25. Same call as alpha/mpc, and
  // published for the same rounds. Null for Classic (8) / Crypto (12).
  neutralCorr?: number | null;
  neutralMmc?: number | null;
  // Signals "new scoring" metrics, sourced from v2RoundModelPerformances.submissionScores.
  // Null for Classic (8) / Crypto (12) rows.
  alpha: number | null;
  mpc: number | null;
  stakeValue: number | null;
};

const SIGNALS_TOURNAMENT = 11;
const CRYPTO_TOURNAMENT = 12;

// Round history window for v2RoundModelPerformances (Signals alpha/mpc + Crypto
// scores). A ceiling well above the lifetime round count so precompute caches
// all available history rather than truncating older rounds.
const MAX_ROUNDS_HISTORY = 1000;

// --refresh-overlap (DEFAULT_CONFIG.refreshOverlapRounds): how many already-stored rounds below the last
// stored round an incremental run re-fetches and rewrites. 0 = write only
// strictly-new rounds (minimum D1 writes). D1 runs keep it at 0 because chasing
// a round's final resolved score needs a window as wide as the resolution lag
// (~24 rounds crypto, ~64 signals) — far more writes than the free plan allows.
// Without that ceiling (the self-hosted SQLite scheduler) pass ~70, so
// still-resolving rounds are rewritten until they settle instead of keeping
// their first-scored values. See getLatestResolvedRound for that boundary.

/**
 * Runs wrangler without a shell: stdout as text, output kept on failure.
 *
 * maxBuffer is raised well above Node's 1MB default because the round-field
 * backfill reads several rounds of a full field at a time — a few megabytes of
 * JSON per call.
 */
const MAX_WRANGLER_OUTPUT_BYTES = 64 * 1024 * 1024;
const runCommand: CommandRunner = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
    maxBuffer: MAX_WRANGLER_OUTPUT_BYTES
  });

/**
 * The lowest round a run should fetch/store, given the highest round already in
 * D1 for this tournament. Returns 0 (full backfill) when D1 is empty for the
 * tournament (maxRoundInD1 === null) or on --reset; otherwise starts `overlap`
 * rounds before the last stored round (never below 0). Pure — unit tested.
 */
export function computeMinRound(
  maxRoundInD1: number | null,
  reset: boolean,
  overlap: number
): number {
  if (reset || maxRoundInD1 === null) return 0;
  return Math.max(0, maxRoundInD1 - overlap + 1);
}

/**
 * The `lastNRounds` window to request from v2RoundModelPerformances given the
 * incremental floor. A full backfill (minRound === 0) requests the whole `cap`;
 * otherwise just the current..minRound span, clamped to [1, cap]. Pure — unit
 * tested.
 */
export function computeRoundsToFetch(
  minRound: number,
  currentRound: number,
  cap: number
): number {
  if (minRound <= 0) return cap;
  return Math.max(1, Math.min(cap, currentRound - minRound + 1));
}

export type TopModel = { modelId: string; modelName: string; username: string; stakeValue: number };

// --- CSV cache ---

interface CacheMeta {
  tournament: number;
  topN: number;
  users: string[];
  models: string[];
  timestamp: string;
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function cacheConfigFingerprint(config: PrecomputeConfig): CacheMeta {
  return {
    tournament: config.tournament,
    topN: config.topN,
    users: [...config.users].sort(),
    models: [...config.models].sort(),
    timestamp: new Date().toISOString()
  };
}

function cacheIsValid(config: PrecomputeConfig): boolean {
  try {
    if (!existsSync(CACHE_META) || !existsSync(CACHE_TOP_MODELS) || !existsSync(CACHE_PERFORMANCES)) {
      return false;
    }
    const meta: CacheMeta = JSON.parse(readFileSync(CACHE_META, 'utf-8'));
    return (
      meta.tournament === config.tournament &&
      meta.topN === config.topN &&
      JSON.stringify([...meta.users].sort()) === JSON.stringify([...config.users].sort()) &&
      JSON.stringify([...meta.models].sort()) === JSON.stringify([...config.models].sort())
    );
  } catch {
    return false;
  }
}

/** Header for performances.csv. Column names drive parsing, so adding one is safe. */
export function performanceCsvHeader(): string {
  return 'modelName,roundNumber,corr,mmc,tc,alpha,mpc,neutralCorr,neutralMmc,stakeValue';
}

export function performanceCsvRow(modelName: string, r: PerformanceRound): string {
  return `${csvEscape(modelName)},${r.roundNumber},${r.corr ?? ''},${r.mmc ?? ''},${r.tc ?? ''},${r.alpha ?? ''},${r.mpc ?? ''},${r.neutralCorr ?? ''},${r.neutralMmc ?? ''},${r.stakeValue ?? ''}`;
}

/**
 * performances.csv in pieces of `linesPerChunk` rows.
 *
 * One string for the whole file overflowed V8's maximum string length on a
 * 20.2M-record Classic run — after sixteen minutes of fetching — so the file is
 * written a chunk at a time and never held whole in memory.
 */
export function* performanceCsvChunks(
  performanceData: ReadonlyMap<string, PerformanceRound[]>,
  linesPerChunk = 50_000
): Generator<string> {
  let lines: string[] = [performanceCsvHeader()];
  for (const [modelName, rounds] of performanceData) {
    for (const r of rounds) {
      lines.push(performanceCsvRow(modelName, r));
      if (lines.length >= linesPerChunk) {
        yield lines.join('\n') + '\n';
        lines = [];
      }
    }
  }
  if (lines.length > 0) yield lines.join('\n') + '\n';
}

/** Parse performances.csv rows, tolerating caches written with fewer columns. */
export function parsePerformanceCsv(lines: ReadonlyArray<string>): Map<string, PerformanceRound[]> {
  const header = csvParseLine(lines[0] ?? '');
  const at = (name: string): number => header.indexOf(name);
  const num = (fields: string[], index: number): number | null =>
    index >= 0 && fields[index] !== undefined && fields[index] !== '' ? parseFloat(fields[index]) : null;

  const performanceData = new Map<string, PerformanceRound[]>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    const fields = csvParseLine(lines[i]);
    const modelName = fields[at('modelName')];
    const round: PerformanceRound = {
      roundNumber: parseInt(fields[at('roundNumber')], 10),
      corr: num(fields, at('corr')),
      mmc: num(fields, at('mmc')),
      tc: num(fields, at('tc')),
      alpha: num(fields, at('alpha')),
      mpc: num(fields, at('mpc')),
      neutralCorr: num(fields, at('neutralCorr')),
      neutralMmc: num(fields, at('neutralMmc')),
      stakeValue: num(fields, at('stakeValue'))
    };
    const existing = performanceData.get(modelName);
    if (existing) existing.push(round);
    else performanceData.set(modelName, [round]);
  }
  return performanceData;
}

function saveCache(
  allModels: TopModel[],
  performanceData: Map<string, PerformanceRound[]>,
  config: PrecomputeConfig
): void {
  mkdirSync(CACHE_DIR, { recursive: true });

  // Write top_models.csv
  const modelLines = ['modelId,modelName,username,stakeValue'];
  for (const m of allModels) {
    modelLines.push(
      `${csvEscape(m.modelId)},${csvEscape(m.modelName)},${csvEscape(m.username)},${m.stakeValue}`
    );
  }
  writeFileSync(CACHE_TOP_MODELS, modelLines.join('\n'), 'utf-8');

  // performances.csv a chunk at a time — see performanceCsvChunks.
  writeFileSync(CACHE_PERFORMANCES, '', 'utf-8');
  for (const chunk of performanceCsvChunks(performanceData)) {
    appendFileSync(CACHE_PERFORMANCES, chunk, 'utf-8');
  }

  // Write meta.json
  writeFileSync(CACHE_META, JSON.stringify(cacheConfigFingerprint(config), null, 2), 'utf-8');
}

function loadCache(): { allModels: TopModel[]; performanceData: Map<string, PerformanceRound[]> } {
  // Parse top_models.csv
  const modelContent = readFileSync(CACHE_TOP_MODELS, 'utf-8');
  const modelLines = modelContent.split('\n').filter(l => l.length > 0);
  const allModels: TopModel[] = [];
  for (let i = 1; i < modelLines.length; i++) {
    const fields = csvParseLine(modelLines[i]);
    allModels.push({
      modelId: fields[0],
      modelName: fields[1],
      username: fields[2],
      stakeValue: parseFloat(fields[3]) || 0
    });
  }

  // performances.csv, parsed by column name so an older cache still loads.
  const perfLines = readFileSync(CACHE_PERFORMANCES, 'utf-8').split('\n');
  const performanceData = parsePerformanceCsv(perfLines);

  return { allModels, performanceData };
}

/**
 * Fetch per-model resolved-round performance. Tournament-aware:
 *  - Classic (8): uses v3UserProfile, reads corr20V2/mmc.
 *  - Signals (11): uses v2SignalsProfile, reads fncV4/mmc20d. Alpha/mpc come
 *    from a separate v2RoundModelPerformances.submissionScores pass below.
 *
 * Returns model UUIDs alongside rounds so the Signals alpha/mpc step can key
 * by modelId (submissionScores requires it).
 */
async function fetchBatchedPerformance(
  modelNames: string[],
  batchSize: number,
  concurrency: number,
  tournament: number,
  minRound = 0
): Promise<Map<string, { modelId: string; accountName: string; rounds: PerformanceRound[] }>> {
  const results = new Map<string, { modelId: string; accountName: string; rounds: PerformanceRound[] }>();
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const profileQuery = isSignals ? 'v2SignalsProfile' : 'v3UserProfile';

  // Chunk into aliased batches, then fetch batches concurrently (graphqlQuery
  // handles 429 backoff). Replaces the old one-request-then-sleep loop.
  const batches: string[][] = [];
  for (let i = 0; i < modelNames.length; i += batchSize) {
    batches.push(modelNames.slice(i, i + batchSize));
  }

  let completed = 0;
  let lastLogged = 0;
  await mapWithConcurrency(batches, concurrency, async (batch, batchIdx) => {
    const aliases = batch.map((name, idx) => {
      // Both profiles share the same selection set; the field names below are
      // present on both (nulls for whichever tournament doesn't populate them).
      return `m${idx}: ${profileQuery}(modelName: ${JSON.stringify(name)}) {
        id username accountName
        roundModelPerformances {
          roundNumber corr corr20V2 corrV4 mmc mmc20d tc fncV4
          selectedStakeValue roundResolved
        }
      }`;
    });

    const queryStr = `query { ${aliases.join('\n')} }`;

    try {
      const data = await graphqlQuery<Record<string, {
        id: string;
        username: string;
        accountName: string;
        roundModelPerformances: Array<{
          roundNumber: number;
          corr: number | null;
          corr20V2: number | null;
          corrV4: number | null;
          mmc: number | null;
          mmc20d: number | null;
          tc: number | null;
          fncV4: number | null;
          selectedStakeValue: number | null;
          roundResolved: boolean | null;
        }>;
      } | null>>(queryStr);

      for (let idx = 0; idx < batch.length; idx++) {
        const alias = `m${idx}`;
        const profile = data[alias];
        const modelName = batch[idx];

        if (!profile) {
          results.set(modelName.toLowerCase(), { modelId: '', accountName: '', rounds: [] });
          continue;
        }

        const rounds: PerformanceRound[] = profile.roundModelPerformances
          // Signals: roundResolved is always false on this profile, so use
          // "has any score" as the resolved-proxy. Classic: trust the flag.
          .filter(r => {
            // Incremental refresh: drop rounds already settled in D1 up front so
            // they never enter memory or the D1 write path.
            if (r.roundNumber < minRound) return false;
            if (isSignals) {
              return (
                r.fncV4 !== null || r.corrV4 !== null ||
                r.corr20V2 !== null || r.corr !== null ||
                r.mmc20d !== null || r.mmc !== null
              );
            }
            return r.roundResolved;
          })
          .map(r => ({
            roundNumber: r.roundNumber,
            // For Signals, the headline correlation is fncV4 (feature-neutral)
            // and mmc20d, matching the alpha/mpc-era reporting.
            corr: isSignals
              ? (r.fncV4 ?? r.corrV4 ?? r.corr20V2 ?? r.corr)
              : (r.corr20V2 ?? r.corr),
            mmc: isSignals ? (r.mmc20d ?? r.mmc) : r.mmc,
            tc: r.tc,
            alpha: null,
            mpc: null,
            stakeValue: r.selectedStakeValue
          }));

        results.set(modelName.toLowerCase(), {
          modelId: profile.id,
          accountName: profile.accountName ?? '',
          rounds
        });
      }
    } catch (error) {
      console.error(`  Error fetching batch ${batchIdx}:`, error);
      for (const name of batch) {
        if (!results.has(name.toLowerCase())) {
          results.set(name.toLowerCase(), { modelId: '', accountName: '', rounds: [] });
        }
      }
    }

    // Concurrent workers finish out of order; throttle progress to ~every 150
    // models so CI logs stay readable.
    completed += batch.length;
    if (completed - lastLogged >= 150 || completed >= modelNames.length) {
      lastLogged = completed;
      console.log(`  Fetched performance for ${completed}/${modelNames.length} models...`);
    }
  });

  return results;
}

/**
 * For each Signals model, fetch v2RoundModelPerformances.submissionScores and
 * merge alpha/mpc into the existing rounds by round number. Mutates `byModel`
 * in place. Best-effort: a failure on one model leaves its alpha/mpc null but
 * doesn't stop the rest.
 */
async function augmentWithAlphaMpc(
  byModel: Map<string, { modelId: string; accountName: string; rounds: PerformanceRound[] }>,
  tournament: number,
  concurrency: number,
  lastNRounds = MAX_ROUNDS_HISTORY
): Promise<void> {
  // Option C: alpha/mpc are only needed for rounds we actually (re)fetched, so
  // skip models with no new rounds. With the incremental round filter upstream,
  // that's every model idle since the last run — a big cut on steady-state days.
  const active = [...byModel.entries()].filter(([, e]) => e.modelId && e.rounds.length > 0);
  const skipped = byModel.size - active.length;
  if (skipped > 0) {
    console.log(`  Skipping ${skipped}/${byModel.size} models with no new rounds (alpha/mpc)`);
  }
  let processed = 0;
  let lastLogged = 0;
  await mapWithConcurrency(active, concurrency, async ([modelKey, entry]) => {
    try {
      const result = await graphqlQuery<{
        v2RoundModelPerformances: Array<{
          roundNumber: number;
          submissionScores: Array<{ displayName: string; value: number | null }> | null;
        }> | null;
      }>(
        `query($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
          v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
            roundNumber
            submissionScores { displayName value }
          }
        }`,
        { modelId: entry.modelId, tournament, lastNRounds }
      );

      const byRound = new Map<number, SignalsScores>();
      for (const r of result.v2RoundModelPerformances ?? []) {
        byRound.set(r.roundNumber, extractSignalsScores(r.submissionScores));
      }

      for (const round of entry.rounds) {
        const scores = byRound.get(round.roundNumber);
        if (scores) {
          round.alpha = scores.alpha;
          round.mpc = scores.mpc;
          round.neutralCorr = scores.neutralCorr;
          round.neutralMmc = scores.neutralMmc;
        }
      }
    } catch (e) {
      console.error(`  Warning: alpha/mpc fetch failed for ${modelKey}:`, e instanceof Error ? e.message : e);
    }

    processed++;
    if (processed - lastLogged >= 50 || processed === active.length) {
      lastLogged = processed;
      console.log(`  Augmented alpha/mpc for ${processed}/${active.length} models...`);
    }
  });
}

export interface SignalsScores {
  alpha: number | null;
  mpc: number | null;
  neutralCorr: number | null;
  neutralMmc: number | null;
}

/**
 * Both Signals metric pairs from one round's submissionScores: alpha/mpc (what
 * payouts use up to ~round 1362) and neutral_corr/neutral_mmc (what they use
 * from rounds opening 2026-09-25). Numerai publishes both for the same rounds.
 */
export function extractSignalsScores(
  submissionScores: Array<{ displayName: string; value: number | null }> | null
): SignalsScores {
  const scores: SignalsScores = { alpha: null, mpc: null, neutralCorr: null, neutralMmc: null };
  for (const s of submissionScores ?? []) {
    if (s.displayName === 'alpha') scores.alpha = s.value;
    else if (s.displayName === 'mpc') scores.mpc = s.value;
    else if (s.displayName === 'neutral_corr') scores.neutralCorr = s.value;
    else if (s.displayName === 'neutral_mmc') scores.neutralMmc = s.value;
  }
  return scores;
}

/**
 * Pull the (corr, mmc) pair out of a crypto round's submissionScores. Crypto
 * scores arrive under displayName 'corr'/'mmc' (alongside canon_corr, mcwcm,
 * season_score, etc.); we rank on corr/mmc to match the worker's t12 metrics.
 */
export function extractCryptoMetrics(
  submissionScores: Array<{ displayName: string; value: number | null }> | null
): { corr: number | null; mmc: number | null } {
  let corr: number | null = null;
  let mmc: number | null = null;
  for (const s of submissionScores ?? []) {
    if (s.displayName === 'corr') corr = s.value;
    if (s.displayName === 'mmc') mmc = s.value;
  }
  return { corr, mmc };
}

/**
 * Fetch per-round corr/mmc for crypto models. Crypto has no profile query
 * (v3UserProfile returns null for crypto models), so we read each model's
 * v2RoundModelPerformances(tournament: 12).submissionScores directly. This is a
 * per-model call (like the Signals alpha/mpc pass), so keep top-n reasonable.
 *
 * roundResolved is unreliable on crypto (stays false even once scored), so we
 * use "has a non-null corr or mmc" as the resolved-proxy, matching Signals.
 */
async function fetchCryptoPerformance(
  models: TopModel[],
  concurrency: number,
  lastNRounds = MAX_ROUNDS_HISTORY
): Promise<Map<string, { modelId: string; accountName: string; rounds: PerformanceRound[] }>> {
  const results = new Map<string, { modelId: string; accountName: string; rounds: PerformanceRound[] }>();
  const total = models.length;
  let processed = 0;
  let lastLogged = 0;

  await mapWithConcurrency(models, concurrency, async (m) => {
    const key = m.modelName.toLowerCase();
    // Crypto's owner column keeps the model name (cryptosignalsLeaderboard is
    // model-level), so accountName is left empty here.
    if (!m.modelId) {
      results.set(key, { modelId: '', accountName: '', rounds: [] });
      processed++;
      return;
    }
    try {
      const data = await graphqlQuery<{
        v2RoundModelPerformances: Array<{
          roundNumber: number;
          submissionScores: Array<{ displayName: string; value: number | null }> | null;
        }> | null;
      }>(
        `query($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
          v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
            roundNumber
            submissionScores { displayName value }
          }
        }`,
        { modelId: m.modelId, tournament: CRYPTO_TOURNAMENT, lastNRounds }
      );

      const rounds: PerformanceRound[] = [];
      for (const r of data.v2RoundModelPerformances ?? []) {
        const { corr, mmc } = extractCryptoMetrics(r.submissionScores);
        if (corr === null && mmc === null) continue;
        rounds.push({
          roundNumber: r.roundNumber,
          corr,
          mmc,
          tc: null,
          alpha: null,
          mpc: null,
          stakeValue: m.stakeValue
        });
      }
      results.set(key, { modelId: m.modelId, accountName: '', rounds });
    } catch (e) {
      console.error(`  Warning: crypto perf fetch failed for ${m.modelName}:`, e instanceof Error ? e.message : e);
      results.set(key, { modelId: m.modelId, accountName: '', rounds: [] });
    }

    processed++;
    if (processed - lastLogged >= 250 || processed === total) {
      lastLogged = processed;
      console.log(`  Fetched crypto performance for ${processed}/${total} models...`);
    }
  });

  return results;
}

// --- D1 storage ---

/**
 * Rows of a round's staked field, as the live ranking path selects them: every
 * model with a positive stake, or every model at all for Crypto, which has no
 * stake data.
 */
function fieldRowsInScope(
  rounds: Array<{ round: PerformanceRound }>,
  tournament: number,
  scope: FieldScope
): FieldRow[] {
  return rounds
    .filter(({ round }) =>
      scope === 'all' || tournament === CRYPTO_TOURNAMENT
        ? true
        : round.stakeValue !== null && round.stakeValue > 0
    )
    .map(({ round }) => toFieldRow(round));
}

/**
 * A fetched round in the shape the stored field reads. The pipeline names the
 * neutral pair neutralCorr/neutralMmc and the database neutral_corr/neutral_mmc,
 * so the translation happens here, once.
 */
function toFieldRow(round: PerformanceRound): FieldRow {
  return {
    corr: round.corr,
    mmc: round.mmc,
    tc: round.tc,
    alpha: round.alpha,
    mpc: round.mpc,
    neutral_corr: round.neutralCorr ?? null,
    neutral_mmc: round.neutralMmc ?? null
  };
}

/** Group the in-memory performance data by round, for rounds at or after `minRound`. */
function roundsFromMemory(
  performanceData: Map<string, PerformanceRound[]>,
  minRound: number
): Map<number, Array<{ round: PerformanceRound }>> {
  const byRound = new Map<number, Array<{ round: PerformanceRound }>>();
  for (const rounds of performanceData.values()) {
    for (const round of rounds) {
      if (round.roundNumber < minRound) continue;
      const list = byRound.get(round.roundNumber);
      if (list) list.push({ round });
      else byRound.set(round.roundNumber, [{ round }]);
    }
  }
  return byRound;
}

/**
 * The stored fields a tournament needs: every scope, times every metric set it
 * has. Only Signals has a second pair (alpha/mpc and the neutral scores), so
 * Classic and Crypto store one field per scope.
 */
function fieldVariants(tournament: number): Array<{ scope: FieldScope; metricSet: MetricSet }> {
  const metricSets = tournament === SIGNALS_TOURNAMENT ? METRIC_SETS : (['alpha_mpc'] as const);
  return FIELD_SCOPES.flatMap((scope) => metricSets.map((metricSet) => ({ scope, metricSet })));
}

/** Rounds read back from D1, for backfilling fields we did not just fetch. */
async function readFieldRowsFromD1(
  d1Query: D1Query,
  tournament: number,
  rounds: number[]
): Promise<Map<number, Array<{ round: PerformanceRound }>>> {
  const byRound = new Map<number, Array<{ round: PerformanceRound }>>();
  if (rounds.length === 0) return byRound;

  // A few rounds per query: one wrangler call per round would dominate the run,
  // and a whole run's worth at once is a multi-megabyte JSON response.
  const CHUNK = 5;
  const sorted = [...rounds].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = sorted.slice(i, i + CHUNK);
    const rows = await d1Query(
      `SELECT round_number, corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc, stake_value FROM model_performances
       WHERE tournament = ${tournament} AND round_number IN (${chunk.join(', ')})`
    );
    for (const row of rows) {
      const roundNumber = Number(row.round_number);
      const round: PerformanceRound = {
        roundNumber,
        corr: toNumberOrNull(row.corr),
        mmc: toNumberOrNull(row.mmc),
        tc: toNumberOrNull(row.tc),
        alpha: toNumberOrNull(row.alpha),
        mpc: toNumberOrNull(row.mpc),
        neutralCorr: toNumberOrNull(row.neutral_corr),
        neutralMmc: toNumberOrNull(row.neutral_mmc),
        stakeValue: toNumberOrNull(row.stake_value)
      };
      const list = byRound.get(roundNumber);
      if (list) list.push({ round });
      else byRound.set(roundNumber, [{ round }]);
    }
  }
  return byRound;
}

/** wrangler --json renders SQL NULL as the string "null" (see refresh-floor.ts). */
function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== 'null' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Store one row per round holding that round's whole field, so ranking a model
 * costs a read per round instead of a read per model per round.
 *
 * Rounds this run fetched are built from memory. Older rounds are read back,
 * `backfillLimit` per run, newest first — the rankings page opens on the most
 * recent rounds, so the view people load is covered first.
 */
async function storeRoundFields(
  d1Query: D1Query,
  tournament: number,
  performanceData: Map<string, PerformanceRound[]>,
  minRound: number,
  coverage: RoundSpan | null,
  backfillLimit: number
): Promise<{ fresh: number; backfilled: number }> {
  const fresh = roundsFromMemory(performanceData, minRound);

  // A round counts as stored only once every variant has its field, so adding a
  // scope or a metric set backfills it over the existing history.
  const variants = fieldVariants(tournament);
  const storedPerVariant = await Promise.all(
    variants.map(({ scope, metricSet }) => readStoredRounds(d1Query, tournament, scope, metricSet))
  );
  const alreadyStored = new Set(
    [...storedPerVariant[0]].filter((round) => storedPerVariant.every((stored) => stored.has(round)))
  );
  const missing = roundsToBackfill(coverage, new Set([...alreadyStored, ...fresh.keys()]), backfillLimit);
  const backfilled = await readFieldRowsFromD1(d1Query, tournament, missing);

  const now = Math.floor(Date.now() / 1000);
  // A field that fails to write is left missing, so a later run picks it up as
  // backfill. These rows only make ranking cheaper — losing one is not worth
  // failing a run whose performance data stored fine.
  const write = async (round: number, rows: Array<{ round: PerformanceRound }>): Promise<boolean> => {
    try {
      for (const { scope, metricSet } of variants) {
        const field = fieldFromRows(fieldRowsInScope(rows, tournament, scope), tournament, metricSet);
        await d1Query(upsertRoundFieldSql(tournament, round, scope, metricSet, encodeFieldMetrics(field), now));
      }
      return true;
    } catch (error) {
      console.warn(`  Could not store the field for round ${round}; leaving it for a later run:`, error);
      return false;
    }
  };

  let written = 0;
  let backfilledWritten = 0;
  for (const [round, rows] of fresh) if (await write(round, rows)) written++;
  for (const [round, rows] of backfilled) if (await write(round, rows)) backfilledWritten++;

  return { fresh: written, backfilled: backfilledWritten };
}

/**
 * A SqlWriter over `wrangler d1 execute --file`, against local or remote D1.
 *
 * D1 file-executes are transactional and occasionally hit a transient "storage
 * operation exceeded timeout which caused object to be reset" (the DB rolls
 * back, so it's safe to retry). Such failures are retried with backoff; anything
 * else, or a failure after the last attempt, is thrown.
 */
function createWranglerWriter(isLocal: boolean): SqlWriter {
  const flag = isLocal ? '--local' : '--remote';
  const isTransientD1Error = (msg: string): boolean =>
    /exceeded timeout|object to be reset|connection (lost|reset)|please try again|temporarily/i.test(msg);

  return async (sql, label) => {
    const tmpFile = join(tmpdir(), `numerai-precompute-${process.pid}-${Date.now()}.sql`);
    const maxAttempts = 4;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        writeFileSync(tmpFile, sql.join('\n'));
        try {
          execSync(`wrangler d1 execute numerai-cache ${flag} --yes --file="${tmpFile}"`, {
            cwd: process.cwd(),
            stdio: ['inherit', 'pipe', 'pipe'],
            encoding: 'utf-8'
          });
          return;
        } catch (error: unknown) {
          const msg = execErrorDetail(error);
          if (attempt < maxAttempts && isTransientD1Error(msg)) {
            const delaySec = attempt * 5;
            console.log(`  ${label} attempt ${attempt}/${maxAttempts} hit a transient D1 error; retrying in ${delaySec}s...`);
            await sleep(delaySec * 1000);
            continue;
          }
          throw new Error(`D1 ${label} failed: ${msg}`);
        }
      }
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  };
}

/** Precompute's D1 target: reads and writes through the wrangler CLI. */
export function createWranglerTarget(isLocal: boolean): PrecomputeTarget {
  return {
    description: `${isLocal ? 'local' : 'remote'} D1`,
    query: createWranglerQuery(runCommand, isLocal),
    write: createWranglerWriter(isLocal)
  };
}

/** Step 5: upsert the models and their per-round rows, BATCH_SIZE statements per write. */
async function storePerformances(
  write: SqlWriter,
  topModels: ReadonlyArray<TopModel>,
  performanceData: Map<string, PerformanceRound[]>,
  tournament: number,
  reset: boolean,
  minRound = 0
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // Normal runs upsert (INSERT OR REPLACE on the PK): resolved history is
  // rewritten in place and new rounds/models are appended — no DELETE needed.
  // --reset clears the tournament first, for one-off migrations (e.g. changing
  // the model source). The clear is chunked by round range so it never hits the
  // per-operation timeout that a single multi-million-row DELETE was causing.
  if (reset) {
    console.log(`  --reset: clearing existing tournament ${tournament} rows (chunked)...`);
    await write([`DELETE FROM top_staked_models WHERE tournament = ${tournament};`], 'delete top_staked_models');
    const CHUNK = 50; // rounds per DELETE — bounds rows-per-operation well under D1's timeout
    for (let lo = 0; lo <= 2000; lo += CHUNK) {
      await write(
        [
          `DELETE FROM model_performances WHERE tournament = ${tournament} AND round_number >= ${lo} AND round_number < ${lo + CHUNK};`
        ],
        `delete rounds ${lo}-${lo + CHUNK - 1}`
      );
    }
    console.log('  Clear complete.');
  }

  // Stream INSERTs to D1 in fixed-size batches. We do NOT build one big array of
  // all statements first: a full Classic fleet is ~5M+ rows, and materialising
  // that many SQL strings at once exhausts the Node heap (OOM). Instead we
  // accumulate up to BATCH_SIZE statements, flush, and reuse the buffer.
  //
  // Each wrangler invocation carries ~2s of fixed overhead; 2000 inline-value
  // INSERTs is a ~400KB SQL file, well within D1's execute limits.
  const BATCH_SIZE = 2000;
  let buffer: string[] = [];
  let batchNum = 0;
  let totalStored = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    batchNum++;
    await write(buffer, `insert batch ${batchNum}`);
    totalStored += buffer.length;
    if (batchNum % 20 === 0) console.log(`  Stored ${totalStored} statements (${batchNum} batches)...`);
    buffer = [];
  };

  for (const model of topModels) {
    const modelId = model.modelId.replace(/'/g, "''");
    const modelName = model.modelName.replace(/'/g, "''");
    const username = model.username.replace(/'/g, "''");
    buffer.push(
      `INSERT OR REPLACE INTO top_staked_models (model_id, model_name, username, stake_value, tournament, updated_at) VALUES ('${modelId}', '${modelName}', '${username}', ${model.stakeValue}, ${tournament}, ${now});`
    );
    if (buffer.length >= BATCH_SIZE) await flush();
  }

  for (const [modelName, rounds] of performanceData) {
    const safeName = modelName.replace(/'/g, "''");
    for (const round of rounds) {
      // Incremental refresh: skip rounds already settled in D1 (below the
      // floor). The overlap window keeps the last few for late corrections.
      if (round.roundNumber < minRound) continue;
      const corr = round.corr !== null ? round.corr : 'NULL';
      const mmc = round.mmc !== null ? round.mmc : 'NULL';
      const tc = round.tc !== null ? round.tc : 'NULL';
      const alpha = round.alpha !== null ? round.alpha : 'NULL';
      const mpc = round.mpc !== null ? round.mpc : 'NULL';
      const neutralCorr = round.neutralCorr ?? 'NULL';
      const neutralMmc = round.neutralMmc ?? 'NULL';
      const stake = round.stakeValue !== null ? round.stakeValue : 'NULL';
      buffer.push(
        `INSERT OR REPLACE INTO model_performances (model_name, round_number, corr, mmc, tc, alpha, mpc, neutral_corr, neutral_mmc, stake_value, tournament, updated_at) VALUES ('${safeName}', ${round.roundNumber}, ${corr}, ${mmc}, ${tc}, ${alpha}, ${mpc}, ${neutralCorr}, ${neutralMmc}, ${stake}, ${tournament}, ${now});`
      );
      if (buffer.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  console.log(`  Stored ${totalStored} statements in ${batchNum} batches.`);
  return totalStored;
}


// --- Main ---

/**
 * Prefix every console.log/warn/error with a UTC wall-clock time and seconds
 * elapsed since the run started, so the CI log reveals which phase is slow
 * (e.g. how long the per-model fetch loop takes vs. the D1 write). Installed
 * from main() only — importing the module for unit tests leaves console alone.
 */
function installTimestampedLogging(): void {
  const start = Date.now();
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const stamp = (): string => {
    const clock = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1).padStart(7, ' ');
    return `[${clock} +${elapsed}s]`;
  };
  console.log = (...args: unknown[]) => orig.log(stamp(), ...args);
  console.warn = (...args: unknown[]) => orig.warn(stamp(), ...args);
  console.error = (...args: unknown[]) => orig.error(stamp(), ...args);
}

/**
 * Steps 5–7: store what a run fetched, then derive the round span and stored
 * round fields from it. Separate from the fetch so it can be exercised against a
 * real database without calling Numerai.
 */
export async function persistRun(
  target: PrecomputeTarget,
  run: {
    allModels: ReadonlyArray<TopModel>;
    performanceData: Map<string, PerformanceRound[]>;
    tournament: number;
    reset: boolean;
    minRound: number;
    backfillRounds: number;
  }
): Promise<{ statements: number; coverage: RoundSpan | null; fresh: number; backfilled: number }> {
  console.log(`Step 5: Storing in ${target.description}...`);
  const statements = await storePerformances(
    target.write,
    run.allModels,
    run.performanceData,
    run.tournament,
    run.reset,
    run.minRound
  );
  console.log('  Done!\n');

  // Step 6: Refresh the tournament's round span, which page loads read instead
  // of scanning model_performances. Recomputed from the table, so it is exact
  // after incremental runs, backfills and resets alike. A failure ends the run
  // loudly: the stored rows are fine, but the UI's latest round would be stale.
  console.log('Step 6: Refreshing tournament coverage...');
  const coverage = await refreshCoverage(target.query, run.tournament);
  console.log(
    coverage
      ? `  Rounds ${coverage.earliestRound}–${coverage.latestRound}\n`
      : '  No rows for this tournament; coverage cleared\n'
  );

  // Step 7: Build the stored per-round fields the rankings page ranks against.
  // Today's rounds come from what we just fetched; older ones are read back a
  // bounded number per run, newest first (--backfill-rounds).
  console.log('Step 7: Storing round fields...');
  const stored = await storeRoundFields(
    target.query,
    run.tournament,
    run.performanceData,
    run.minRound,
    coverage,
    run.backfillRounds
  );
  console.log(`  Wrote ${stored.fresh} new and ${stored.backfilled} backfilled round(s)\n`);

  return { statements, coverage, ...stored };
}

/**
 * The whole pipeline, against whichever database `createTarget` returns for the
 * parsed CLI options.
 */
export async function runPrecompute(
  createTarget: (options: { isLocal: boolean }) => PrecomputeTarget
): Promise<void> {
  installTimestampedLogging();
  const { config, isLocal, noCache, reset } = buildConfig();
  const target = createTarget({ isLocal });

  console.log('\n=== Numerai Rankings Precompute ===');
  console.log(`Tournament:  ${config.tournament}`);
  console.log(`Top N:       ${config.topN}`);
  console.log(`Batch size:  ${config.batchSize}`);
  console.log(`Rate limit:  ${config.rateLimitMs}ms (paged scans only)`);
  console.log(`Concurrency: ${config.concurrency} (performance fetches)`);
  console.log(`Users:       ${config.users.length > 0 ? config.users.join(', ') : '(none)'}`);
  console.log(`Models:      ${config.models.length > 0 ? config.models.join(', ') : '(none)'}`);
  console.log(`Cache:       ${noCache ? 'disabled (--no-cache)' : 'enabled'}`);
  console.log(`Overlap:     ${config.refreshOverlapRounds} stored round(s) re-fetched`);
  console.log(`Unstaked:    ${config.includeUnstaked ? 'included' : 'skipped (Classic)'}`);
  console.log(`Target:      ${target.description}\n`);

  let allModels: TopModel[];
  let performanceData: Map<string, PerformanceRound[]>;

  // Incremental refresh floor: only fetch/write rounds newer than the last round
  // already stored (--refresh-overlap re-writes that many recent rounds too;
  // default 0 = strictly-new). Full backfill (minRound 0) when nothing is stored for
  // this tournament or on --reset. This keeps each daily run to a handful of new
  // rounds instead of rewriting the entire history (which was OOMing/timing out
  // and, being first in the job, blocking later tournaments).
  //
  // A failed read throws and ends the run (exit 1) rather than being mistaken for
  // an empty tournament — see refresh-floor.ts for the incidents that caused.
  const maxRoundInD1 = reset ? null : await readMaxRound(target.query, config.tournament);
  const minRound = computeMinRound(maxRoundInD1, reset, config.refreshOverlapRounds);
  if (reset) {
    console.log('Refresh mode: --reset — full backfill.\n');
  } else if (maxRoundInD1 === null) {
    console.log('Refresh mode: full backfill (no existing rounds for this tournament).\n');
  } else {
    console.log(
      `Refresh mode: incremental — D1 has rounds up to ${maxRoundInD1}; fetching from round ${minRound} (overlap ${config.refreshOverlapRounds}).\n`
    );
  }

  const useCache = !noCache && cacheIsValid(config);

  if (useCache) {
    const meta: CacheMeta = JSON.parse(readFileSync(CACHE_META, 'utf-8'));
    console.log(`Using cached data from ${meta.timestamp}`);
    const cached = loadCache();
    allModels = cached.allModels;
    performanceData = cached.performanceData;
    console.log(`  Loaded ${allModels.length} models, ${[...performanceData.values()].reduce((s, r) => s + r.length, 0)} performance records from cache\n`);
  } else {
    if (!noCache) {
      console.log('No valid cache found, fetching from API...\n');
    }

    // Step 1: Get current round
    console.log('Step 1: Fetching current round...');
    const currentRound = await getCurrentRound(config.tournament);
    console.log(`  Current round: ${currentRound}\n`);

    // Step 2: Fetch staked models. All three tournaments use model-level
    // leaderboards (Classic: v2Leaderboard, Signals: signalsLeaderboard, Crypto:
    // cryptosignalsLeaderboard), so every staked model — including an account's
    // secondary models — is captured.
    console.log(`Step 2: Fetching top ${config.topN} staked models...`);
    const topModels = await fetchTopStakedModels(
      config.tournament,
      config.topN,
      config.rateLimitMs,
      config.includeUnstaked
    );
    console.log(`  Found ${topModels.length} models\n`);

    // Step 3: Fetch specific user models if configured
    allModels = [...topModels];
    const existingNames = new Set(topModels.map(m => m.modelName.toLowerCase()));

    if (config.users.length > 0) {
      console.log(`Step 3a: Fetching models for ${config.users.length} specific users...`);
      const userModels = await fetchUserModels(config.users, config.tournament, config.rateLimitMs);
      for (const model of userModels) {
        if (!existingNames.has(model.modelName.toLowerCase())) {
          allModels.push(model);
          existingNames.add(model.modelName.toLowerCase());
          console.log(`  Added user model: ${model.modelName} (${model.username})`);
        }
      }
      console.log('');
    }

    // Add specific model names if configured
    if (config.models.length > 0) {
      console.log(`Step 3b: Adding ${config.models.length} specific models...`);
      for (const modelName of config.models) {
        if (!existingNames.has(modelName.toLowerCase())) {
          allModels.push({
            modelId: '',
            modelName,
            username: '',
            stakeValue: 0
          });
          existingNames.add(modelName.toLowerCase());
          console.log(`  Queued model: ${modelName}`);
        }
      }
      console.log('');
    }

    // Step 4: Fetch performance data. Crypto has no profile query, so it reads
    // per-model v2RoundModelPerformances; Classic/Signals use batched profiles.
    // The incremental floor bounds how much history each path pulls.
    const roundsToFetch = computeRoundsToFetch(minRound, currentRound, MAX_ROUNDS_HISTORY);
    console.log(`Step 4: Fetching performance data for ${allModels.length} models (last ${roundsToFetch} rounds, concurrency ${config.concurrency})...`);
    const modelNames = allModels.map(m => m.modelName);
    const fetched = config.tournament === CRYPTO_TOURNAMENT
      ? await fetchCryptoPerformance(allModels, config.concurrency, roundsToFetch)
      : await fetchBatchedPerformance(
          modelNames,
          config.batchSize,
          config.concurrency,
          config.tournament,
          minRound
        );

    // Step 4b: For Signals, fetch alpha/mpc from submissionScores. This is a
    // per-model query so it's slow on large fleets — keep topN modest for
    // Signals runs (config.topN drives it).
    if (config.tournament === SIGNALS_TOURNAMENT) {
      console.log(`Step 4b: Augmenting ${fetched.size} Signals models with alpha/mpc...`);
      await augmentWithAlphaMpc(fetched, SIGNALS_TOURNAMENT, config.concurrency, roundsToFetch);
      console.log('  Alpha/mpc augmentation complete\n');
    }

    // Step 4c: Crypto's leaderboard/perf queries expose only the model name, so
    // build a model→account map to populate the table's owner column.
    let cryptoAccountMap = new Map<string, string>();
    if (config.tournament === CRYPTO_TOURNAMENT) {
      console.log('Step 4c: Resolving owning accounts for Crypto models...');
      cryptoAccountMap = await fetchModelAccountMap(config.tournament, config.batchSize, config.rateLimitMs, config.concurrency);
      console.log(`  Resolved ${cryptoAccountMap.size} model→account mappings\n`);
    }

    // Convert to the storage shape (Map<modelName, rounds[]>).
    performanceData = new Map<string, PerformanceRound[]>();
    for (const [modelName, entry] of fetched) {
      performanceData.set(modelName, entry.rounds);
      const allModel = allModels.find(m => m.modelName.toLowerCase() === modelName);
      if (allModel) {
        // If the leaderboard didn't supply a modelId (specific-model entries),
        // backfill from the profile fetch so D1 has the canonical id.
        if (!allModel.modelId && entry.modelId) {
          allModel.modelId = entry.modelId;
        }
        // Set the owning account so the table's owner column isn't just the model
        // name. Classic/Signals get accountName from the profile fetch; Crypto
        // from the model→account map built above.
        const accountName =
          (entry as { accountName?: string }).accountName || cryptoAccountMap.get(modelName);
        if (accountName) {
          allModel.username = accountName;
        }
      }
    }

    let totalRounds = 0;
    for (const rounds of performanceData.values()) {
      totalRounds += rounds.length;
    }
    console.log(`  Fetched ${totalRounds} total round records\n`);

    // Save to CSV cache. --no-cache means this run neither reads nor writes one:
    // the nightly scheduler passes it, and a full Classic fleet is millions of
    // rows nobody will reuse.
    if (noCache) {
      console.log('Cache disabled (--no-cache); not writing one\n');
    } else {
      console.log('Saving data to cache...');
      saveCache(allModels, performanceData, config);
      console.log(`  Cache written to ${CACHE_DIR}\n`);
    }
  }

  let totalRounds = 0;
  for (const rounds of performanceData.values()) {
    totalRounds += rounds.length;
  }

  await persistRun(target, {
    allModels,
    performanceData,
    tournament: config.tournament,
    reset,
    minRound,
    backfillRounds: config.backfillRounds
  });

  console.log('=== Precomputation complete! ===');
  console.log(`  Models:              ${allModels.length}`);
  console.log(`  Performance records: ${totalRounds}`);
  console.log(`  Tournament:          ${config.tournament}`);
}

// Only run the pipeline when invoked as the CLI entry point — importing this
// module (e.g. from tests for the pure helpers) must not kick off API calls.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /precompute\.[cm]?ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  runPrecompute(({ isLocal }) => createWranglerTarget(isLocal)).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
