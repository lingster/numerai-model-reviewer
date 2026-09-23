/**
 * TypeScript types for Numerai Model Comparison app
 */
import type { FieldScope } from '$lib/utils/field-scope.js';

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
/** One metric's weight in a round's payout formula. */
export interface PayoutMultiplier {
	/** API metric key, e.g. `correlation_60`. */
	name: string;
	/** Short label, matching our metric ids where possible, e.g. `corr60`. */
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
	/** 60-day MMC. Classic only — Signals and Crypto do not publish it. */
	mmc60?: number | null;
	/**
	 * Payout weighting in force for this round, from the API. Classic since
	 * 28 Aug 2026 is 3xCORR60 + 15xMMC60; earlier rounds keep their own weights.
	 */
	payoutMultipliers?: PayoutMultiplier[] | null;
	fnc: number | null;
	tc?: number | null;
	// New Numerai scoring (Signals): alpha + mpc
	alpha?: number | null;
	mpc?: number | null;
	/**
	 * Neutral correlation / neutral MMC — the pair Numerai pays Signals on for
	 * rounds opening on/after 2026-09-25 (see SIGNALS_METRIC_SETS.neutral in
	 * scoring.ts). Null for Classic/Crypto, and for Signals rounds before ~912
	 * or not yet scored.
	 */
	neutralCorr?: number | null;
	neutralMmc?: number | null;
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
	mmc60: number | null;
	fnc: number | null;
	payout: number | null;
	// New Numerai scoring (Signals)
	alpha: number | null;
	mpc: number | null;
	// Neutral pair (Signals): neutral correlation + neutral MMC. See
	// RoundPerformance.neutralCorr/neutralMmc for availability caveats.
	ncorr: number | null;
	nmmc: number | null;
	// Calculated weighted score for whichever Signals metric set is active
	// (alpha/mpc or ncorr/nmmc) — see computeChartScore in utils/scoring.ts.
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
export type ChartMetric =
	| 'corr20'
	| 'corr60'
	| 'mmc'
	| 'mmc60'
	| 'fnc'
	| 'payout'
	| 'alpha'
	| 'mpc'
	| 'ncorr'
	| 'nmmc'
	| 'score';

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
	/** Size of the ranked field for this round; used to derive a percentile. */
	totalModels: number;
}

/**
 * Ranking history for a model across multiple rounds
 */
export interface ModelRankingHistory {
	modelId: string;
	modelName: string;
	username: string;
	/**
	 * Which competitor field this history was ranked against — 'staked' (what
	 * payouts use) or 'all' (every model that scored). Optional (defaults to
	 * 'staked') so existing fixtures/tests that predate the fieldScope toggle
	 * keep compiling; set explicitly by calculateModelRankings. When the "vs
	 * Both" toggle is active, a model produces two histories — one per scope —
	 * so the chart can render both fields' rank lines.
	 */
	fieldScope?: FieldScope;
	rankings: Array<{
		roundNumber: number;
		rank: number | null;
		/**
		 * Per-round corr/mmc (alpha/mpc for Signals). When a rolling window is
		 * active these are the windowed averages (e.g. MMC20/CORR60). Used to
		 * overlay raw-metric lines on the rankings chart.
		 */
		corr: number | null;
		mmc: number | null;
		customScore: number | null;
		totalModels: number;
		/**
		 * Whether the model was staked for this round (what payouts use). null
		 * means no data — predates staked-tracking, or the round is Crypto's
		 * (tournament 12), whose stored stake is the model's CURRENT stake, not
		 * a per-round fact, so the Worker always returns null there. Optional so
		 * fixtures/tests written before this field existed keep compiling.
		 */
		staked?: boolean | null;
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
