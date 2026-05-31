/**
 * Unit tests for the live Worker model-performance API.
 *
 * These mock `global.fetch` so they run without a live Numerai endpoint and
 * assert on the GraphQL variables we send — specifically that Crypto and
 * Signals performance fetches request the full available history
 * (MAX_ROUNDS_HISTORY) rather than a short window that truncates older rounds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelPerformance, type Env } from './api';
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
