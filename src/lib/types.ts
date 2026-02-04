/**
 * TypeScript types for Numerai Model Comparison app
 */

/**
 * Represents a Numerai user
 */
export interface NumeraiUser {
	id: string;
	username: string;
}

/**
 * Represents a Numerai model
 */
export interface NumeraiModel {
	id: string;
	name: string;
	username: string;
	tournament?: number;
}

/**
 * Performance data for a single round
 */
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

/**
 * Data point for time series chart
 */
export interface ChartDataPoint {
	roundNumber: number;
	date: Date;
	resolved: boolean;
	corr20: number | null;
	corr60: number | null;
	mmc: number | null;
	fnc: number | null;
	tc: number | null;
	payout: number | null;
}

/**
 * Series data for a single model in the chart
 */
export interface ModelSeries {
	modelId: string;
	modelName: string;
	username: string;
	color: string;
	visible: boolean;
	data: ChartDataPoint[];
}

/**
 * Available metrics for the time series chart
 */
export type ChartMetric = 'corr20' | 'corr60' | 'mmc' | 'fnc' | 'tc' | 'payout';

/**
 * Stake information for a model
 */
export interface StakeInfo {
	corrMultiplier: number | null;
	mmcMultiplier: number | null;
	tcMultiplier: number | null;
}

/**
 * Full performance data for a model
 */
export interface ModelPerformance {
	modelId: string;
	modelName: string;
	username: string;
	stakeValue: number | null;
	stakeInfo: StakeInfo | null;
	rounds: RoundPerformance[];
}

/**
 * A saved chart configuration
 */
export interface SavedChart {
	id: string;
	name: string;
	models: string[];
	dateRange: {
		start: string;
		end: string;
	};
	createdAt: string;
}

/**
 * Options for autocomplete component
 */
export interface AutocompleteOption<T = unknown> {
	id: string;
	label: string;
	value: T;
}

/**
 * Model score data for a specific round (used for ranking calculations)
 */
export interface RoundModelScore {
	modelId: string;
	modelName: string;
	username: string;
	roundNumber: number;
	corr: number | null;
	mmc: number | null;
	tc: number | null;
	stakeValue: number | null;
	customScore: number | null;
	rank: number | null;
}

/**
 * Round leaderboard data containing all staked models for a round
 */
export interface RoundLeaderboard {
	roundNumber: number;
	tournament: number;
	models: RoundModelScore[];
	fetchedAt: number;
}

/**
 * Ranking history for a model across multiple rounds
 */
export interface ModelRankingHistory {
	modelId: string;
	modelName: string;
	username: string;
	rankings: Array<{
		roundNumber: number;
		rank: number | null;
		customScore: number | null;
		totalModels: number;
	}>;
}

/**
 * Custom score formula configuration
 */
export interface ScoreFormula {
	mmcWeight: number;
	corrWeight: number;
	tcWeight: number;
}
