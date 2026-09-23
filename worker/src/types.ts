export interface NumeraiUser {
  id: string;
  username: string;
}

export interface NumeraiModel {
  id: string;
  name: string;
  username: string;
  tournament?: number;
  // Current stake (NMR) and 1-year return (%) — shown in the model picker so
  // users can compare models at a glance. Optional: not all code paths populate them.
  stake?: number | null;
  return1y?: number | null;
}

export interface StakeInfo {
  corrMultiplier: number | null;
  mmcMultiplier: number | null;
  tcMultiplier: number | null;
}

/** One metric's weight in a round's payout formula. */
export interface PayoutMultiplier {
  /** API metric key, e.g. `correlation_60`. */
  name: string;
  /** Short label matching our metric ids where possible, e.g. `corr60`. */
  displayName: string;
  multiplier: number;
}

export interface RoundPerformance {
  roundNumber: number;
  roundOpenTime?: string;
  roundResolveTime?: string;
  roundResolved?: boolean;
  correlation: number | null;
  corr60?: number | null;
  mmc: number | null;
  // 60-day MMC. Classic only: sourced from submissionScores (roundModelPerformances
  // has no mmc60 field), and null for Signals and Crypto, which do not publish it.
  mmc60?: number | null;
  /**
   * The payout weighting in force for this round, straight from the API — e.g.
   * Classic since 28 Aug 2026 returns corr60 x3 and mmc60 x15. Per round rather
   * than per model, so historical rounds keep the weights they were paid under.
   */
  payoutMultipliers?: PayoutMultiplier[] | null;
  fnc: number | null;
  tc?: number | null;
  // New Numerai scoring (Signals): alpha + mpc. Null for tournaments/rounds
  // that do not expose them.
  alpha?: number | null;
  mpc?: number | null;
  // Signals' neutral pair (neutral correlation / neutral contribution), which
  // Numerai pays on from rounds opening 2026-09-25. Same source as alpha/mpc.
  neutralCorr?: number | null;
  neutralMmc?: number | null;
  corrMultiplier: number | null;
  mmcMultiplier?: number | null;
  selectedStakeValue: number | null;
  payout?: number | null;
}

export interface ModelPerformance {
  modelId: string;
  modelName: string;
  username: string;
  stakeValue: number | null;
  stakeInfo: StakeInfo | null;
  rounds: RoundPerformance[];
}
