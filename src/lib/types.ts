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
	/** Current stake in NMR (when known) — shown in the model picker. */
	stake?: number | null;
	/** Trailing 1-year return as a percentage (when known) — shown in the model picker. */
	return1y?: number | null;
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
	// New Numerai scoring (Signals): alpha + mpc
	alpha?: number | null;
	mpc?: number | null;
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
	// New Numerai scoring (Signals)
	alpha: number | null;
	mpc: number | null;
	// Calculated weighted score: alphaWeight*alpha + mpcWeight*mpc
	score: number | null;
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
export type ChartMetric = 'corr20' | 'corr60' | 'mmc' | 'fnc' | 'tc' | 'payout' | 'alpha' | 'mpc' | 'score';

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

/**
 * One histogram bucket of a round's score distribution
 */
export interface DistributionBin {
	x0: number;
	x1: number;
	allCount: number;
	stakedCount: number;
}

/**
 * A model's position within a round's score distribution
 */
export interface DistributionModelEntry {
	modelName: string;
	username: string;
	corr: number | null;
	mmc: number | null;
	stakeValue: number | null;
	staked: boolean;
	score: number;
	/** 1 = best score in the field. */
	rank: number;
	/** 0–100; 100 = top of the field. */
	percentile: number;
}

/**
 * Score distribution for a round (histogram + the user's models within it)
 */
export interface RoundDistribution {
	round: number;
	tournament: number;
	totalModels: number;
	stakedModels: number;
	bins: DistributionBin[];
	models: DistributionModelEntry[];
}
