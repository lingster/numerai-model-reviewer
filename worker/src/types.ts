export interface NumeraiUser {
  id: string;
  username: string;
}

export interface NumeraiModel {
  id: string;
  name: string;
  username: string;
  tournament?: number;
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
