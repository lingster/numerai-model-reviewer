/**
 * Pure, tournament-aware mappers from raw Numerai GraphQL round data to the
 * normalised `RoundPerformance` shape consumed by the frontend.
 *
 * Kept free of Cloudflare/runtime dependencies so it can be unit-tested in
 * isolation. Shared by the Classic, Signals and (standard) performance paths
 * to avoid duplicating the field-selection logic (DRY).
 *
 * Field selection differs by tournament:
 *  - Classic (8): correlation = corr20V2 ?? corr,  mmc = mmc
 *  - Signals (11): the Classic corr/mmc fields are null. The headline
 *    correlation lives in `fncV4` (feature-neutral corr) and MMC in `mmc20d`.
 */
import type { RoundPerformance } from './types';

/** Numerai tournament ids. */
export const SIGNALS_TOURNAMENT = 11;
export const CRYPTO_TOURNAMENT = 12;

/**
 * Raw round shape as returned by `v3UserProfile`/`v2SignalsProfile`.
 * All score fields are optional/nullable; `Nmr` scalars arrive as strings.
 */
export interface RawRoundModelPerformance {
	roundNumber: number;
	roundOpenTime?: string | null;
	roundResolveTime?: string | null;
	roundResolved?: boolean | null;
	corr?: number | null;
	corr20V2?: number | null;
	corr60?: number | null;
	corrV4?: number | null;
	mmc?: number | null;
	mmc20d?: number | null;
	fnc?: number | null;
	fncV3?: number | null;
	fncV4?: number | null;
	tc?: number | null;
	corrMultiplier?: number | null;
	mmcMultiplier?: number | null;
	selectedStakeValue?: number | string | null;
	payout?: number | string | null;
}

/** Safely coerce a number-or-string-or-null value to a finite number or null. */
export const toNumber = (value: number | string | null | undefined): number | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Map a single raw round to a normalised `RoundPerformance`.
 * @param r The raw round from the GraphQL API.
 * @param tournament Tournament id; controls which score fields are read.
 */
export function mapRoundPerformance(
	r: RawRoundModelPerformance,
	tournament?: number
): RoundPerformance {
	const isSignals = tournament === SIGNALS_TOURNAMENT;

	// Signals headline correlation is the feature-neutral fncV4; corrV4/corr20V2
	// are fallbacks only (currently null for Signals models).
	const correlation = isSignals
		? toNumber(r.fncV4 ?? r.corrV4 ?? r.corr20V2)
		: toNumber(r.corr20V2 ?? r.corr);
	const mmc = isSignals ? toNumber(r.mmc20d ?? r.mmc) : toNumber(r.mmc);

	return {
		roundNumber: r.roundNumber,
		roundOpenTime: r.roundOpenTime ?? undefined,
		roundResolveTime: r.roundResolveTime ?? undefined,
		roundResolved: r.roundResolved ?? !!r.roundResolveTime,
		correlation,
		corr60: toNumber(r.corr60),
		mmc,
		fnc: toNumber(r.fncV4 ?? r.fncV3 ?? r.fnc),
		tc: toNumber(r.tc),
		corrMultiplier: toNumber(r.corrMultiplier),
		mmcMultiplier: toNumber(r.mmcMultiplier),
		selectedStakeValue: toNumber(r.selectedStakeValue),
		payout: toNumber(r.payout)
	};
}

/** Map an array of raw rounds. Null/undefined input maps to an empty list. */
export function mapRoundPerformances(
	rounds: RawRoundModelPerformance[] | null | undefined,
	tournament?: number
): RoundPerformance[] {
	return (rounds ?? []).map((r) => mapRoundPerformance(r, tournament));
}
