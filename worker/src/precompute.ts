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
  users: string[];
  models: string[];
}

const DEFAULT_CONFIG: PrecomputeConfig = {
  tournament: 8,
  topN: 10000,
  // Max batchSize is 3 — higher values exceed the Numerai API rate limit
  batchSize: 3,
  rateLimitMs: 1000,
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

function parseCliArgs(): { isLocal: boolean; noCache: boolean; overrides: Partial<PrecomputeConfig> } {
  const args = process.argv.slice(2);
  const isLocal = args.includes('--local');
  const noCache = args.includes('--no-cache');
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
    }
  }

  return { isLocal, noCache, overrides };
}

function buildConfig(): { config: PrecomputeConfig; isLocal: boolean; noCache: boolean } {
  const yamlConfig = loadYamlConfig();
  const { isLocal, noCache, overrides } = parseCliArgs();

  // Merge: defaults < yaml < cli args
  const config: PrecomputeConfig = {
    ...DEFAULT_CONFIG,
    ...yamlConfig,
    ...overrides,
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

  return { config, isLocal, noCache };
}

// --- API helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphqlQuery<T>(queryStr: string, variables?: Record<string, unknown>): Promise<T> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(NUMERAI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryStr, variables })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const isRateLimit = response.status === 429 || text.includes('rate limit');
      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, 16s, 32s
        console.log(`  Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const result: GraphQLResponse<T> = await response.json() as GraphQLResponse<T>;
    if (result.errors?.length) {
      const isRateLimit = result.errors.some(e => e.message.toLowerCase().includes('rate limit'));
      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`  Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
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
  throw new Error('Max retries exceeded');
}

async function getCurrentRound(tournament: number): Promise<number> {
  const result = await graphqlQuery<{ rounds: Array<{ number: number }> }>(
    `query($tournament: Int!) { rounds(tournament: $tournament, limit: 1) { number } }`,
    { tournament }
  );
  return result.rounds[0].number;
}

// --- Data fetching ---

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

  while (models.length < limit && offset < limit + batchSize) {
    // Signals: signalsLeaderboard is model-level (id = model UUID, username = model name).
    // Crypto: cryptosignalsLeaderboard is likewise model-level (one row per crypto model).
    // Classic: accountLeaderboard is account-level but its displayName is the primary
    // model name (one row per account), which is what v3UserProfile expects.
    const queryStr = isSignals
      ? `query($limit: Int!, $offset: Int!) {
          signalsLeaderboard(limit: $limit, offset: $offset) {
            id username nmrStaked
          }
        }`
      : isCrypto
      ? `query($limit: Int!, $offset: Int!) {
          cryptosignalsLeaderboard(limit: $limit, offset: $offset) {
            id username nmrStaked
          }
        }`
      : `query($limit: Int!, $offset: Int!, $tournament: Int!) {
          accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
            id username displayName nmrStaked
          }
        }`;
    const vars = isSignals || isCrypto
      ? { limit: batchSize, offset }
      : { limit: batchSize, offset, tournament };

    const result = await graphqlQuery<{
      accountLeaderboard?: Array<{ id: string; username: string; displayName: string; nmrStaked: string | null }>;
      signalsLeaderboard?: Array<{ id: string; username: string; nmrStaked: string | null }>;
      cryptosignalsLeaderboard?: Array<{ id: string; username: string; nmrStaked: string | null }>;
    }>(queryStr, vars);

    const mapModelLevel = (e: { id: string; username: string; nmrStaked: string | null }) => ({
      id: e.id,
      username: e.username,
      displayName: e.username, // Signals/Crypto: username IS the model name
      nmrStaked: e.nmrStaked
    });
    const batch = isSignals
      ? (result.signalsLeaderboard ?? []).map(mapModelLevel)
      : isCrypto
      ? (result.cryptosignalsLeaderboard ?? []).map(mapModelLevel)
      : (result.accountLeaderboard ?? []);

    if (batch.length === 0) break;

    for (const entry of batch) {
      if (models.length < limit) {
        models.push({
          modelId: entry.id,
          modelName: entry.displayName || entry.username,
          username: entry.username,
          stakeValue: entry.nmrStaked ? parseFloat(entry.nmrStaked) : 0
        });
      }
    }

    console.log(`  Fetched ${models.length}/${limit} top staked models...`);
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
  rateLimitMs: number,
  tournament: number
): Promise<Map<string, { modelId: string; rounds: PerformanceRound[] }>> {
  const results = new Map<string, { modelId: string; rounds: PerformanceRound[] }>();
  const isSignals = tournament === SIGNALS_TOURNAMENT;
  const profileQuery = isSignals ? 'v2SignalsProfile' : 'v3UserProfile';

  for (let i = 0; i < modelNames.length; i += batchSize) {
    const batch = modelNames.slice(i, i + batchSize);

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
          results.set(modelName.toLowerCase(), { modelId: '', rounds: [] });
          continue;
        }

        const rounds: PerformanceRound[] = profile.roundModelPerformances
          // Signals: roundResolved is always false on this profile, so use
          // "has any score" as the resolved-proxy. Classic: trust the flag.
          .filter(r => {
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

        results.set(modelName.toLowerCase(), { modelId: profile.id, rounds });
      }
    } catch (error) {
      console.error(`  Error fetching batch at index ${i}:`, error);
      for (const name of batch) {
        if (!results.has(name.toLowerCase())) {
          results.set(name.toLowerCase(), { modelId: '', rounds: [] });
        }
      }
    }

    const completed = Math.min(i + batchSize, modelNames.length);
    // batchSize is tiny (≈3, Numerai rate limit) so this loop runs thousands of
    // times — throttle progress to keep CI logs readable.
    const batchNum = Math.floor(i / batchSize) + 1;
    if (batchNum % 50 === 0 || completed >= modelNames.length) {
      console.log(`  Fetched performance for ${completed}/${modelNames.length} models...`);
    }

    if (i + batchSize < modelNames.length) {
      await sleep(rateLimitMs);
    }
  }

  return results;
}

/**
 * For each Signals model, fetch v2RoundModelPerformances.submissionScores and
 * merge alpha/mpc into the existing rounds by round number. Mutates `byModel`
 * in place. Best-effort: a failure on one model leaves its alpha/mpc null but
 * doesn't stop the rest.
 */
async function augmentWithAlphaMpc(
  byModel: Map<string, { modelId: string; rounds: PerformanceRound[] }>,
  tournament: number,
  rateLimitMs: number,
  lastNRounds = 200
): Promise<void> {
  let processed = 0;
  const total = byModel.size;
  for (const [modelKey, entry] of byModel) {
    if (!entry.modelId || entry.rounds.length === 0) {
      processed++;
      continue;
    }
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
    if (processed % 25 === 0) {
      console.log(`  Augmented alpha/mpc for ${processed}/${total} models...`);
    }
    await sleep(rateLimitMs);
  }
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
  rateLimitMs: number,
  lastNRounds = 300
): Promise<Map<string, { modelId: string; rounds: PerformanceRound[] }>> {
  const results = new Map<string, { modelId: string; rounds: PerformanceRound[] }>();
  let processed = 0;
  const total = models.length;

  for (const m of models) {
    const key = m.modelName.toLowerCase();
    if (!m.modelId) {
      results.set(key, { modelId: '', rounds: [] });
      processed++;
      continue;
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
      results.set(key, { modelId: m.modelId, rounds });
    } catch (e) {
      console.error(`  Warning: crypto perf fetch failed for ${m.modelName}:`, e instanceof Error ? e.message : e);
      results.set(key, { modelId: m.modelId, rounds: [] });
    }

    processed++;
    if (processed % 50 === 0 || processed === total) {
      console.log(`  Fetched crypto performance for ${processed}/${total} models...`);
    }
    await sleep(rateLimitMs);
  }

  return results;
}

// --- D1 storage ---

async function storeInD1(
  topModels: Array<{ modelId: string; modelName: string; username: string; stakeValue: number }>,
  performanceData: Map<string, PerformanceRound[]>,
  tournament: number,
  isLocal: boolean
): Promise<void> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const pathModule = await import('path');
  const os = await import('os');

  const flag = isLocal ? '--local' : '--remote';
  const now = Math.floor(Date.now() / 1000);

  const statements: string[] = [];

  statements.push(`DELETE FROM top_staked_models WHERE tournament = ${tournament};`);
  statements.push(`DELETE FROM model_performances WHERE tournament = ${tournament};`);

  for (const model of topModels) {
    const modelId = model.modelId.replace(/'/g, "''");
    const modelName = model.modelName.replace(/'/g, "''");
    const username = model.username.replace(/'/g, "''");
    statements.push(
      `INSERT OR REPLACE INTO top_staked_models (model_id, model_name, username, stake_value, tournament, updated_at) VALUES ('${modelId}', '${modelName}', '${username}', ${model.stakeValue}, ${tournament}, ${now});`
    );
  }

  for (const [modelName, rounds] of performanceData) {
    for (const round of rounds) {
      const safeName = modelName.replace(/'/g, "''");
      const corr = round.corr !== null ? round.corr : 'NULL';
      const mmc = round.mmc !== null ? round.mmc : 'NULL';
      const tc = round.tc !== null ? round.tc : 'NULL';
      const alpha = round.alpha !== null ? round.alpha : 'NULL';
      const mpc = round.mpc !== null ? round.mpc : 'NULL';
      const stake = round.stakeValue !== null ? round.stakeValue : 'NULL';
      statements.push(
        `INSERT OR REPLACE INTO model_performances (model_name, round_number, corr, mmc, tc, alpha, mpc, stake_value, tournament, updated_at) VALUES ('${safeName}', ${round.roundNumber}, ${corr}, ${mmc}, ${tc}, ${alpha}, ${mpc}, ${stake}, ${tournament}, ${now});`
      );
    }
  }

  // Each wrangler invocation carries ~2s of fixed overhead, which dominates the
  // store phase (a 386k-row store was ~770 calls ≈ 26 min, almost all overhead).
  // Larger batches cut the call count proportionally; 2000 inline-value INSERTs
  // is a ~400KB SQL file, well within D1's execute limits.
  const BATCH_SIZE = 2000;
  const totalBatches = Math.ceil(statements.length / BATCH_SIZE);
  console.log(`  Executing ${statements.length} SQL statements in ${totalBatches} batches of ${BATCH_SIZE}...`);

  const tmpFile = pathModule.join(os.tmpdir(), `numerai-precompute-${Date.now()}.sql`);

  for (let b = 0; b < totalBatches; b++) {
    const batch = statements.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    fs.writeFileSync(tmpFile, batch.join('\n'));

    try {
      // Output is captured (not echoed): wrangler prints a multi-line summary
      // per call, which floods the log across 100+ batches. Only surface it on
      // failure (in the catch below) and emit a throttled progress line.
      execSync(`wrangler d1 execute numerai-cache ${flag} --yes --file="${tmpFile}"`, {
        cwd: process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe'],
        encoding: 'utf-8'
      });
      if ((b + 1) % 20 === 0 || b + 1 === totalBatches) {
        console.log(`  Stored ${b + 1}/${totalBatches} batches...`);
      }
    } catch (error: any) {
      fs.unlinkSync(tmpFile);
      const stderr = error.stderr ? error.stderr.toString() : '';
      const stdout = error.stdout ? error.stdout.toString() : '';
      console.error(`  Batch ${b + 1}/${totalBatches} failed:`);
      if (stderr) console.error(`  stderr: ${stderr}`);
      if (stdout) console.error(`  stdout: ${stdout}`);
      throw new Error(`D1 batch ${b + 1} failed: ${stderr || stdout || error.message}`);
    }
  }

  fs.unlinkSync(tmpFile);
}

// --- Main ---

async function main() {
  const { config, isLocal, noCache } = buildConfig();

  console.log('\n=== Numerai Rankings Precompute ===');
  console.log(`Tournament:  ${config.tournament}`);
  console.log(`Top N:       ${config.topN}`);
  console.log(`Batch size:  ${config.batchSize}`);
  console.log(`Rate limit:  ${config.rateLimitMs}ms`);
  console.log(`Users:       ${config.users.length > 0 ? config.users.join(', ') : '(none)'}`);
  console.log(`Models:      ${config.models.length > 0 ? config.models.join(', ') : '(none)'}`);
  console.log(`Cache:       ${noCache ? 'disabled (--no-cache)' : 'enabled'}`);
  console.log(`Target:      ${isLocal ? 'local' : 'remote'} D1\n`);

  let allModels: TopModel[];
  let performanceData: Map<string, PerformanceRound[]>;

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

    // Step 2: Fetch top staked models
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
    console.log(`Step 4: Fetching performance data for ${allModels.length} models...`);
    const modelNames = allModels.map(m => m.modelName);
    const fetched = config.tournament === CRYPTO_TOURNAMENT
      ? await fetchCryptoPerformance(allModels, config.rateLimitMs)
      : await fetchBatchedPerformance(
          modelNames,
          config.batchSize,
          config.rateLimitMs,
          config.tournament
        );

    // Step 4b: For Signals, fetch alpha/mpc from submissionScores. This is a
    // per-model query so it's slow on large fleets — keep topN modest for
    // Signals runs (config.topN drives it).
    if (config.tournament === SIGNALS_TOURNAMENT) {
      console.log(`Step 4b: Augmenting ${fetched.size} Signals models with alpha/mpc...`);
      await augmentWithAlphaMpc(fetched, SIGNALS_TOURNAMENT, config.rateLimitMs);
      console.log('  Alpha/mpc augmentation complete\n');
    }

    // Convert to the storage shape (Map<modelName, rounds[]>).
    performanceData = new Map<string, PerformanceRound[]>();
    for (const [modelName, entry] of fetched) {
      performanceData.set(modelName, entry.rounds);
      // If the leaderboard didn't supply a modelId (specific-model entries),
      // backfill from the profile fetch so D1 has the canonical id.
      const allModel = allModels.find(m => m.modelName.toLowerCase() === modelName);
      if (allModel && !allModel.modelId && entry.modelId) {
        allModel.modelId = entry.modelId;
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
  await storeInD1(allModels, performanceData, config.tournament, isLocal);
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
