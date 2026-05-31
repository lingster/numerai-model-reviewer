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

export interface RoundPerformance {
  roundNumber: number;
  roundOpenTime?: string;
  roundResolveTime?: string;
  roundResolved?: boolean;
  correlation: number | null;
  corr60?: number | null;
  mmc: number | null;
  fnc: number | null;
  tc?: number | null;
  // New Numerai scoring (Signals): alpha + mpc. Null for tournaments/rounds
  // that do not expose them.
  alpha?: number | null;
  mpc?: number | null;
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
