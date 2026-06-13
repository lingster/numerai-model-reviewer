/**
 * Unit tests for getRoundDistribution.
 *
 * Mocks env.DB (same pattern as rankings-api.unit.test.ts) so they run without
 * a live Worker/D1. Pins the histogram split (all vs staked), the rank /
 * percentile maths for requested models, and that unstaked models are part of
 * the field — the distribution view is the one consumer that must NOT apply
 * the stake_value > 0 filter the other rankings endpoints use.
 */
import { describe, expect, it } from "vitest";
import { getRoundDistribution } from "./rankings-api";

type Row = {
  round_number: number;
  model_name: string;
  corr: number | null;
  mmc: number | null;
  tc: number | null;
  alpha: number | null;
  mpc: number | null;
  stake_value: number | null;
};

const FORMULA = { corrWeight: 1, mmcWeight: 1, tcWeight: 0 };

function mockEnv(
  rows: Row[],
  usernames: Array<{ model_name: string; username: string }> = [],
) {
  const DB = {
    prepare(sql: string) {
      const isPerf = /model_performances/i.test(sql);
      return {
        bind(...args: unknown[]) {
          return {
            all: async () => {
              if (!isPerf) return { results: usernames };
              const [round] = args as number[];
              return { results: rows.filter((r) => r.round_number === round) };
            },
            first: async () => null,
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

type Env = Parameters<typeof getRoundDistribution>[0];

function row(
  model: string,
  corr: number,
  mmc: number,
  stake: number | null,
): Row {
  return {
    round_number: 100,
    model_name: model,
    corr,
    mmc,
    tc: null,
    alpha: null,
    mpc: null,
    stake_value: stake,
  };
}

describe("getRoundDistribution", () => {
  it("includes unstaked models in the field and splits bin counts by stake", async () => {
    const env = mockEnv([
      row("staked_hi", 0.3, 0.3, 5), // score 0.6
      row("unstaked_mid", 0.1, 0.1, null), // score 0.2
      row("staked_lo", -0.2, -0.2, 1), // score -0.4
    ]);

    const res = await getRoundDistribution(env, {
      round: 100,
      tournament: 8,
      formula: FORMULA,
      models: [],
    });

    expect(res.totalModels).toBe(3);
    expect(res.stakedModels).toBe(2);

    const allTotal = res.bins.reduce((n, b) => n + b.allCount, 0);
    const stakedTotal = res.bins.reduce((n, b) => n + b.stakedCount, 0);
    expect(allTotal).toBe(3);
    expect(stakedTotal).toBe(2);

    // Bins must span the score extent [-0.4, 0.6].
    expect(res.bins[0].x0).toBeCloseTo(-0.4);
    expect(res.bins[res.bins.length - 1].x1).toBeCloseTo(0.6);
  });

  it("ranks requested models against the whole field with percentiles", async () => {
    const env = mockEnv(
      [
        row("best", 0.5, 0.5, 10), // score 1.0 → rank 1
        row("mine", 0.2, 0.2, null), // score 0.4 → rank 2 (unstaked)
        row("mid", 0.1, 0.1, 3), // score 0.2 → rank 3
        row("worst", -0.3, -0.3, 1), // score -0.6 → rank 4
      ],
      [{ model_name: "mine", username: "me" }],
    );

    const res = await getRoundDistribution(env, {
      round: 100,
      tournament: 8,
      formula: FORMULA,
      models: ["MINE"], // case-insensitive match
    });

    expect(res.models).toHaveLength(1);
    const mine = res.models[0];
    expect(mine.modelName).toBe("mine");
    expect(mine.username).toBe("me");
    expect(mine.rank).toBe(2);
    expect(mine.staked).toBe(false);
    expect(mine.score).toBeCloseTo(0.4);
    // Rank 2 of 4 → beats 2 of the other 3 models → 66.7th percentile.
    expect(mine.percentile).toBeCloseTo((2 / 3) * 100);
  });

  it("returns an empty distribution for a round with no data", async () => {
    const env = mockEnv([]);
    const res = await getRoundDistribution(env, {
      round: 100,
      tournament: 8,
      formula: FORMULA,
      models: ["mine"],
    });
    expect(res.totalModels).toBe(0);
    expect(res.bins).toHaveLength(0);
    expect(res.models).toHaveLength(0);
  });

  it("collapses an all-identical-score field to a single bin", async () => {
    const env = mockEnv([row("a", 0.1, 0.1, 1), row("b", 0.1, 0.1, null)]);
    const res = await getRoundDistribution(env, {
      round: 100,
      tournament: 8,
      formula: FORMULA,
      models: [],
    });
    expect(res.bins).toHaveLength(1);
    expect(res.bins[0].allCount).toBe(2);
    expect(res.bins[0].stakedCount).toBe(1);
  });
});
