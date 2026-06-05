/**
 * Unit tests for the live Worker model-performance API.
 *
 * These mock `global.fetch` so they run without a live Numerai endpoint and
 * assert on the GraphQL variables we send — specifically that Crypto and
 * Signals performance fetches request the full available history
 * (MAX_ROUNDS_HISTORY) rather than a short window that truncates older rounds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelPerformance, findCryptoModelByName, clearUserModelsCache, type Env } from './api';
import { MAX_ROUNDS_HISTORY, CRYPTO_TOURNAMENT, SIGNALS_TOURNAMENT } from './mappers';

const env = {
  NUMERAI_PUBLIC_KEY: 'pk',
  NUMERAI_SECRET_KEY: 'sk',
  NUMERAI_API_URL: 'https://example.invalid/graphql',
  DB: {} as unknown
} as unknown as Env;

interface CapturedCall {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Install a fetch mock that records every GraphQL request and returns the
 * provided `data` payload for each call (cycled if fewer than the call count).
 */
function mockFetch(dataResponses: unknown[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ query: body.query, variables: body.variables ?? {} });
      const data = dataResponses[Math.min(i, dataResponses.length - 1)];
      i++;
      return new Response(JSON.stringify({ data }), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearUserModelsCache();
});

describe('getModelPerformance round history window', () => {
  it('requests the full history for Crypto models', async () => {
    const calls = mockFetch([{ v2RoundModelPerformances: [] }]);

    await getModelPerformance('mymodel', env, 'owner', 'model-id-123', CRYPTO_TOURNAMENT);

    const cryptoCall = calls.find((c) => 'lastNRounds' in c.variables);
    expect(cryptoCall?.variables.lastNRounds).toBe(MAX_ROUNDS_HISTORY);
  });

  it('requests the full history for Signals alpha/mpc augmentation', async () => {
    const calls = mockFetch([
      { v2SignalsProfile: { id: 'model-id-123', username: 'mymodel', accountName: 'owner', roundModelPerformances: [] } },
      { v2RoundModelPerformances: [] }
    ]);

    await getModelPerformance('mymodel', env, 'owner', 'model-id-123', SIGNALS_TOURNAMENT);

    const augmentCall = calls.find((c) => 'lastNRounds' in c.variables);
    expect(augmentCall?.variables.lastNRounds).toBe(MAX_ROUNDS_HISTORY);
  });
});

describe('getModelPerformance Crypto stake value', () => {
  it('populates stakeValue from the account model stake (not hard-coded null)', async () => {
    // Crypto v2RoundModelPerformances carries no stake; it must be sourced from
    // accountProfile(...).models[].stake. fncc_t1 stakes 56.2559… ≈ 56.26 NMR.
    mockFetch([
      {
        v2RoundModelPerformances: [
          { roundNumber: 1282, roundOpenTime: null, roundResolveTime: null, roundResolved: false, submissionScores: [] }
        ]
      },
      {
        accountProfile: {
          id: 'acc-1',
          username: 'fish_n_chips',
          models: [
            { id: 'b27db79e', displayName: 'fncc_t1', tournament: CRYPTO_TOURNAMENT, stake: '56.255925615126436000' }
          ]
        }
      }
    ]);

    const perf = await getModelPerformance('fncc_t1', env, 'fish_n_chips', 'b27db79e', CRYPTO_TOURNAMENT);

    expect(perf?.stakeValue).toBeCloseTo(56.26, 2);
  });

  it('maps corr/mmc multipliers from Crypto rounds (not hard-coded null)', async () => {
    mockFetch([
      {
        v2RoundModelPerformances: [
          {
            roundNumber: 1282,
            roundOpenTime: null,
            roundResolveTime: null,
            roundResolved: false,
            corrMultiplier: 0.05,
            mmcMultiplier: 0.5,
            submissionScores: [{ displayName: 'corr', value: 0.01 }]
          }
        ]
      },
      { accountProfile: { id: 'acc-1', username: 'fish_n_chips', models: [] } }
    ]);

    const perf = await getModelPerformance('fncc_t1', env, 'fish_n_chips', 'b27db79e', CRYPTO_TOURNAMENT);

    expect(perf?.rounds[0].corrMultiplier).toBe(0.05);
    expect(perf?.rounds[0].mmcMultiplier).toBe(0.5);
  });

  it('caches the account model lookup across Crypto fetches for the same (username, tournament)', async () => {
    // Comparing N models from one account must not issue N identical
    // accountProfile lookups — the per-account model list is cached.
    const calls = mockFetch([
      { v2RoundModelPerformances: [] },
      {
        accountProfile: {
          id: 'acc-1',
          username: 'fish_n_chips',
          models: [
            { id: 'm1', displayName: 'fncc_t1', tournament: CRYPTO_TOURNAMENT, stake: '10' },
            { id: 'm2', displayName: 'fncc_t2', tournament: CRYPTO_TOURNAMENT, stake: '20' }
          ]
        }
      },
      { v2RoundModelPerformances: [] }
    ]);

    const a = await getModelPerformance('fncc_t1', env, 'fish_n_chips', 'm1', CRYPTO_TOURNAMENT);
    const b = await getModelPerformance('fncc_t2', env, 'fish_n_chips', 'm2', CRYPTO_TOURNAMENT);

    expect(a?.stakeValue).toBe(10);
    expect(b?.stakeValue).toBe(20);
    // Exactly one accountProfile lookup despite two performance fetches.
    const accountProfileCalls = calls.filter((c) => c.query.includes('accountProfile'));
    expect(accountProfileCalls.length).toBe(1);
  });

  it('leaves stakeValue null when the model is not found among the account models', async () => {
    mockFetch([
      { v2RoundModelPerformances: [] },
      { accountProfile: { id: 'acc-1', username: 'fish_n_chips', models: [] } }
    ]);

    const perf = await getModelPerformance('fncc_t1', env, 'fish_n_chips', 'b27db79e', CRYPTO_TOURNAMENT);

    expect(perf?.stakeValue).toBeNull();
  });
});

/**
 * Build an Env whose DB returns `row` from the single-row top_staked_models
 * lookup. Records every SQL statement prepared so tests can assert the query.
 */
function envWithStakedRow(row: Record<string, unknown> | null) {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return {
            first: async () => row,
            all: async () => ({ results: row ? [row] : [] })
          };
        }
      };
    }
  };
  return { env: { ...env, DB: db } as unknown as Env, statements };
}

describe('findCryptoModelByName N+1 avoidance', () => {
  it('resolves from D1 top_staked_models without any API call', async () => {
    const calls = mockFetch([{}]); // fetch must NOT be used
    const { env: dbEnv, statements } = envWithStakedRow({
      model_id: 'crypto-id-1',
      model_name: 'ac_001',
      username: 'aas',
      tournament: CRYPTO_TOURNAMENT
    });

    const model = await findCryptoModelByName('ac_001', CRYPTO_TOURNAMENT, dbEnv);

    expect(model).toEqual({
      id: 'crypto-id-1',
      name: 'ac_001',
      username: 'aas',
      tournament: CRYPTO_TOURNAMENT
    });
    // The whole point: no leaderboard scan / per-user fetch.
    expect(calls.length).toBe(0);
    // And it used the PK-indexed lookup on top_staked_models.
    expect(statements.some((s) => /top_staked_models/i.test(s) && /model_name/i.test(s))).toBe(true);
  });

  it('falls back to a single getUserModels call when the username is known and the model is unstaked', async () => {
    // D1 miss → one getUserModels(username) GraphQL call returning the model.
    const calls = mockFetch([
      {
        accountProfile: {
          id: 'acc-1',
          username: 'aas',
          models: [
            { id: 'crypto-id-9', displayName: 'unstaked_x', tournament: CRYPTO_TOURNAMENT }
          ]
        }
      }
    ]);
    const { env: dbEnv } = envWithStakedRow(null);

    const model = await findCryptoModelByName('unstaked_x', CRYPTO_TOURNAMENT, dbEnv, 'aas');

    expect(model?.name).toBe('unstaked_x');
    expect(model?.id).toBe('crypto-id-9');
    // Exactly one API call — the user's models — not a leaderboard scan.
    expect(calls.length).toBe(1);
  });
});
