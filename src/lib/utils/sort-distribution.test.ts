import { describe, expect, it } from "vitest";
import { sortDistributionModels } from "./sort-distribution";
import type { DistributionModelEntry } from "$lib/types.js";

function entry(
  overrides: Partial<DistributionModelEntry>,
): DistributionModelEntry {
  return {
    modelName: "m",
    username: "u",
    corr: 0,
    mmc: 0,
    stakeValue: null,
    staked: false,
    score: 0,
    rank: 1,
    percentile: 50,
    ...overrides,
  };
}

describe("sortDistributionModels", () => {
  it("sorts numerically by score descending", () => {
    const models = [
      entry({ modelName: "low", score: -0.1 }),
      entry({ modelName: "high", score: 0.5 }),
      entry({ modelName: "mid", score: 0.2 }),
    ];
    const sorted = sortDistributionModels(models, "score", "desc");
    expect(sorted.map((m) => m.modelName)).toEqual(["high", "mid", "low"]);
  });

  it("sorts by model name case-insensitively", () => {
    const models = [
      entry({ modelName: "Zeta" }),
      entry({ modelName: "alpha" }),
      entry({ modelName: "Beta" }),
    ];
    const sorted = sortDistributionModels(models, "modelName", "asc");
    expect(sorted.map((m) => m.modelName)).toEqual(["alpha", "Beta", "Zeta"]);
  });

  it("puts null values last in both directions", () => {
    const models = [
      entry({ modelName: "nostake", stakeValue: null }),
      entry({ modelName: "big", stakeValue: 10 }),
      entry({ modelName: "small", stakeValue: 1 }),
    ];
    expect(
      sortDistributionModels(models, "stakeValue", "asc").map(
        (m) => m.modelName,
      ),
    ).toEqual(["small", "big", "nostake"]);
    expect(
      sortDistributionModels(models, "stakeValue", "desc").map(
        (m) => m.modelName,
      ),
    ).toEqual(["big", "small", "nostake"]);
  });

  it("does not mutate the input array", () => {
    const models = [
      entry({ modelName: "b", rank: 2 }),
      entry({ modelName: "a", rank: 1 }),
    ];
    const copy = [...models];
    sortDistributionModels(models, "rank", "asc");
    expect(models).toEqual(copy);
  });
});
