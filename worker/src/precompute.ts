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
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { mapWithConcurrency } from './concurrency';

const NUMERAI_API_URL = 'https://api-tournament.numer.ai/graphql';

const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_TOP_MODELS = join(CACHE_DIR, 'top_models.csv');
const CACHE_PERFORMANCES = join(CACHE_DIR, 'performances.csv');
const CACHE_META = join(CACHE_DIR, 'meta.json');

// --- Config types ---

interface PrecomputeConfig {
  tournament: number;
  topN: number;
  batchSize: number;
  rateLimitMs: number;
  concurrency: number;
  users: string[];
  models: string[];
}

const DEFAULT_CONFIG: PrecomputeConfig = {
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
  const overrides: Partial<PrecomputeConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--top-n':
        if (next) { overrides.topN = parseInt(next, 10); i++; }
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

async function fetchTopStakedModels(
  tournament: number,
  limit: number,
  rateLimitMs: number
): Promise<Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>> {
  const models: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }> = [];
  const batchSize = 500;
  let offset = 0;
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const isCrypto = tournament === CRYPTO_TOURNAMENT;
  const isClassic = !isSignals && !isCrypto;

  // All three leaderboards are model-level (one row per model, with the model's
  // own stake), so secondary staked models are captured:
  //   Classic: v2Leaderboard, Signals: signalsLeaderboard, Crypto: cryptosignalsLeaderboard.
  // v2Leaderboard is ordered by rank (not stake) and includes many unstaked
  // models, so for Classic we keep only stake > 0 to bound the set; Signals/Crypto
  // take their entries as-is.
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
      if (isClassic && stake <= 0) continue; // skip unstaked models in the Classic field
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

type PerformanceRound = {
  roundNumber: number;
  corr: number | null;
  mmc: number | null;
  tc: number | null;
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

// Incremental refresh re-fetches this many already-stored rounds below the last
// round in D1, so a round that resolves (or is corrected by Numerai) slightly
// late still gets picked up on the next run. Small: the overlap is pure re-work.
const REFRESH_OVERLAP_ROUNDS = 2;

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

type TopModel = { modelId: string; modelName: string; username: string; stakeValue: number };

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

  // Write performances.csv (with alpha/mpc for Signals)
  const perfLines = ['modelName,roundNumber,corr,mmc,tc,alpha,mpc,stakeValue'];
  for (const [modelName, rounds] of performanceData) {
    for (const r of rounds) {
      perfLines.push(
        `${csvEscape(modelName)},${r.roundNumber},${r.corr ?? ''},${r.mmc ?? ''},${r.tc ?? ''},${r.alpha ?? ''},${r.mpc ?? ''},${r.stakeValue ?? ''}`
      );
    }
  }
  writeFileSync(CACHE_PERFORMANCES, perfLines.join('\n'), 'utf-8');

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

  // Parse performances.csv. Tolerate the legacy 6-column format
  // (no alpha/mpc) for caches written before this change.
  const perfContent = readFileSync(CACHE_PERFORMANCES, 'utf-8');
  const perfLines = perfContent.split('\n').filter(l => l.length > 0);
  const headerCols = csvParseLine(perfLines[0] ?? '');
  const hasAlphaMpc = headerCols.includes('alpha') && headerCols.includes('mpc');
  const performanceData = new Map<string, PerformanceRound[]>();
  for (let i = 1; i < perfLines.length; i++) {
    const fields = csvParseLine(perfLines[i]);
    const modelName = fields[0];
    const round: PerformanceRound = hasAlphaMpc
      ? {
          roundNumber: parseInt(fields[1], 10),
          corr: fields[2] !== '' ? parseFloat(fields[2]) : null,
          mmc: fields[3] !== '' ? parseFloat(fields[3]) : null,
          tc: fields[4] !== '' ? parseFloat(fields[4]) : null,
          alpha: fields[5] !== '' ? parseFloat(fields[5]) : null,
          mpc: fields[6] !== '' ? parseFloat(fields[6]) : null,
          stakeValue: fields[7] !== '' ? parseFloat(fields[7]) : null
        }
      : {
          roundNumber: parseInt(fields[1], 10),
          corr: fields[2] !== '' ? parseFloat(fields[2]) : null,
          mmc: fields[3] !== '' ? parseFloat(fields[3]) : null,
          tc: fields[4] !== '' ? parseFloat(fields[4]) : null,
          alpha: null,
          mpc: null,
          stakeValue: fields[5] !== '' ? parseFloat(fields[5]) : null
        };
    if (!performanceData.has(modelName)) {
      performanceData.set(modelName, []);
    }
    performanceData.get(modelName)!.push(round);
  }

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

      const byRound = new Map<number, { alpha: number | null; mpc: number | null }>();
      for (const r of result.v2RoundModelPerformances ?? []) {
        let alpha: number | null = null;
        let mpc: number | null = null;
        for (const s of r.submissionScores ?? []) {
          if (s.displayName === 'alpha') alpha = s.value;
          if (s.displayName === 'mpc') mpc = s.value;
        }
        byRound.set(r.roundNumber, { alpha, mpc });
      }

      for (const round of entry.rounds) {
        const scores = byRound.get(round.roundNumber);
        if (scores) {
          round.alpha = scores.alpha;
          round.mpc = scores.mpc;
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
 * Highest round_number already stored in D1 for a tournament, or null when the
 * tournament has no rows yet (first-ever backfill). Drives the incremental
 * refresh: each run then only fetches/writes rounds at/after this (minus a small
 * overlap) instead of rewriting the entire multi-million-row history every day.
 * Best-effort: any read/parse failure returns null so the run falls back to a
 * full backfill rather than aborting.
 */
async function getMaxRoundInD1(tournament: number, isLocal: boolean): Promise<number | null> {
  const { execSync } = await import('child_process');
  const flag = isLocal ? '--local' : '--remote';
  try {
    const out = execSync(
      `wrangler d1 execute numerai-cache ${flag} --yes --json --command "SELECT MAX(round_number) AS maxRound FROM model_performances WHERE tournament = ${tournament}"`,
      { cwd: process.cwd(), encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] }
    );
    // wrangler --json emits an array of statement results: [{ results: [...] }].
    const parsed = JSON.parse(out);
    const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
    const maxRound = results?.[0]?.maxRound;
    return typeof maxRound === 'number' ? maxRound : null;
  } catch (error) {
    console.warn(
      `  Could not read max round from D1 (falling back to full backfill): ${(error as Error).message}`
    );
    return null;
  }
}

async function storeInD1(
  topModels: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>,
  performanceData: Map<string, PerformanceRound[]>,
  tournament: number,
  isLocal: boolean,
  reset: boolean,
  minRound = 0
): Promise<void> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const pathModule = await import('path');
  const os = await import('os');

  const flag = isLocal ? '--local' : '--remote';
  const now = Math.floor(Date.now() / 1000);

  const tmpFile = pathModule.join(os.tmpdir(), `numerai-precompute-${Date.now()}.sql`);

  // D1 file-executes are transactional and occasionally hit a transient
  // "storage operation exceeded timeout which caused object to be reset" (the
  // DB rolls back, so it's safe to retry). Retry such failures with backoff;
  // re-throw anything else or after exhausting attempts.
  const isTransientD1Error = (msg: string): boolean =>
    /exceeded timeout|object to be reset|connection (lost|reset)|please try again|temporarily/i.test(msg);

  const execD1 = async (sql: string[], label: string): Promise<void> => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      fs.writeFileSync(tmpFile, sql.join('\n'));
      try {
        execSync(`wrangler d1 execute numerai-cache ${flag} --yes --file="${tmpFile}"`, {
          cwd: process.cwd(),
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf-8'
        });
        return;
      } catch (error: any) {
        const msg = (error.stderr?.toString() || '') + (error.stdout?.toString() || '') || error.message;
        if (attempt < maxAttempts && isTransientD1Error(msg)) {
          const delaySec = attempt * 5;
          console.log(`  ${label} attempt ${attempt}/${maxAttempts} hit a transient D1 error; retrying in ${delaySec}s...`);
          await sleep(delaySec * 1000);
          continue;
        }
        throw new Error(`D1 ${label} failed: ${msg}`);
      }
    }
  };

  // Normal runs upsert (INSERT OR REPLACE on the PK): resolved history is
  // rewritten in place and new rounds/models are appended — no DELETE needed.
  // --reset clears the tournament first, for one-off migrations (e.g. changing
  // the model source). The clear is chunked by round range so it never hits the
  // per-operation timeout that a single multi-million-row DELETE was causing.
  if (reset) {
    console.log(`  --reset: clearing existing tournament ${tournament} rows (chunked)...`);
    await execD1([`DELETE FROM top_staked_models WHERE tournament = ${tournament};`], 'delete top_staked_models');
    const CHUNK = 50; // rounds per DELETE — bounds rows-per-operation well under D1's timeout
    for (let lo = 0; lo <= 2000; lo += CHUNK) {
      await execD1(
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
    await execD1(buffer, `insert batch ${batchNum}`);
    totalStored += buffer.length;
    if (batchNum % 20 === 0) console.log(`  Stored ${totalStored} statements (${batchNum} batches)...`);
    buffer = [];
  };

  try {
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
        const stake = round.stakeValue !== null ? round.stakeValue : 'NULL';
        buffer.push(
          `INSERT OR REPLACE INTO model_performances (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at) VALUES ('${safeName}', ${round.roundNumber}, ${corr}, ${mmc}, ${tc}, ${alpha}, ${mpc}, ${stake}, ${tournament}, ${now});`
        );
        if (buffer.length >= BATCH_SIZE) await flush();
      }
    }

    await flush();
    console.log(`  Stored ${totalStored} statements in ${batchNum} batches.`);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
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

async function main() {
  installTimestampedLogging();
  const { config, isLocal, noCache, reset } = buildConfig();

  console.log('\n=== Numerai Rankings Precompute ===');
  console.log(`Tournament:  ${config.tournament}`);
  console.log(`Top N:       ${config.topN}`);
  console.log(`Batch size:  ${config.batchSize}`);
  console.log(`Rate limit:  ${config.rateLimitMs}ms (paged scans only)`);
  console.log(`Concurrency: ${config.concurrency} (performance fetches)`);
  console.log(`Users:       ${config.users.length > 0 ? config.users.join(', ') : '(none)'}`);
  console.log(`Models:      ${config.models.length > 0 ? config.models.join(', ') : '(none)'}`);
  console.log(`Cache:       ${noCache ? 'disabled (--no-cache)' : 'enabled'}`);
  console.log(`Target:      ${isLocal ? 'local' : 'remote'} D1\n`);

  let allModels: TopModel[];
  let performanceData: Map<string, PerformanceRound[]>;

  // Incremental refresh floor: only fetch/write rounds at/after the last round
  // already in D1 (minus a small overlap). Full backfill (minRound 0) when D1 is
  // empty for this tournament or on --reset. This keeps each daily run to a
  // handful of new rounds instead of rewriting the entire history (which was
  // OOMing/timing out and, being first in the job, blocking later tournaments).
  const maxRoundInD1 = reset ? null : await getMaxRoundInD1(config.tournament, isLocal);
  const minRound = computeMinRound(maxRoundInD1, reset, REFRESH_OVERLAP_ROUNDS);
  if (reset) {
    console.log('Refresh mode: --reset — full backfill.\n');
  } else if (maxRoundInD1 === null) {
    console.log('Refresh mode: full backfill (no existing rounds for this tournament).\n');
  } else {
    console.log(
      `Refresh mode: incremental — D1 has rounds up to ${maxRoundInD1}; fetching from round ${minRound} (overlap ${REFRESH_OVERLAP_ROUNDS}).\n`
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
    const topModels = await fetchTopStakedModels(config.tournament, config.topN, config.rateLimitMs);
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

    // Save to CSV cache
    console.log('Saving data to cache...');
    saveCache(allModels, performanceData, config);
    console.log(`  Cache written to ${CACHE_DIR}\n`);
  }

  let totalRounds = 0;
  for (const rounds of performanceData.values()) {
    totalRounds += rounds.length;
  }

  // Step 5: Store in D1
  console.log('Step 5: Storing in D1...');
  await storeInD1(allModels, performanceData, config.tournament, isLocal, reset, minRound);
  console.log('  Done!\n');

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
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
