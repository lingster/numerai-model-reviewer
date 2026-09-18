/**
 * A round's field — every scored model's metrics for one round — stored as a
 * single row.
 *
 * Ranking a model in a round means knowing how many models scored above it, so
 * the live path reads every model's row for that round: ~4.6k rows per round,
 * ~300k for the default 30-round view of one model. Stored like this it is one
 * read per round instead, which is what makes rankings affordable on D1's free
 * plan.
 *
 * Two deliberate choices:
 *  - Metrics are stored, not scores. The payout formula changes (Classic moved
 *    to 3xCORR60 + 15xMMC60 on 28 Aug 2026) and the UI's weight sliders vary it
 *    per request, so storing scores would invalidate history and force the live
 *    path for custom weights.
 *  - Model identity is not stored. Ranking needs the distribution plus the one
 *    model's own metrics, and those come from its own model_performances rows.
 *    Leaving names out keeps a round at ~24KB rather than ~80KB.
 */

import { rankAmong, scoreFromMetrics, type MetricTriple, type ScoreFormula } from './ranking';

/** One round's metric pairs, index-aligned: model i is (corr[i], mmc[i]). */
export interface FieldMetrics {
	corr: ReadonlyArray<number | null>;
	mmc: ReadonlyArray<number | null>;
}

/** The same pairs decoded, with a missing metric as NaN. */
export interface DecodedFieldMetrics {
	corr: Float32Array;
	mmc: Float32Array;
}

/** A stored field: two base64 Float32 arrays. */
export interface EncodedFieldMetrics {
	corr: string;
	mmc: string;
}

/** A model's standing in a round. */
export interface FieldRank {
	rank: number;
	totalModels: number;
}

const toFloat32 = (values: ReadonlyArray<number | null>): Float32Array => {
	const packed = new Float32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		// NaN marks "no metric", which must stay distinct from a real 0.
		packed[i] = values[i] === null || values[i] === undefined ? NaN : (values[i] as number);
	}
	return packed;
};

const toBase64 = (packed: Float32Array): string => {
	const bytes = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
};

const fromBase64 = (encoded: string): Float32Array => {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

/** Pack a round's metric pairs for storage. */
export function encodeFieldMetrics(metrics: FieldMetrics): EncodedFieldMetrics {
	if (metrics.corr.length !== metrics.mmc.length) {
		throw new RangeError(
			`corr and mmc must have the same length, got ${metrics.corr.length} and ${metrics.mmc.length}`
		);
	}
	return { corr: toBase64(toFloat32(metrics.corr)), mmc: toBase64(toFloat32(metrics.mmc)) };
}

/** Unpack a stored round field. */
export function decodeFieldMetrics(encoded: EncodedFieldMetrics): DecodedFieldMetrics {
	return { corr: fromBase64(encoded.corr), mmc: fromBase64(encoded.mmc) };
}

/**
 * Every score in the field under `formula`, skipping models with no metrics —
 * the same models the live path drops before ranking.
 */
function scoresIn(field: DecodedFieldMetrics, formula: ScoreFormula): number[] {
	const scores: number[] = [];
	for (let i = 0; i < field.corr.length; i++) {
		const corr = Number.isNaN(field.corr[i]) ? null : field.corr[i];
		const mmc = Number.isNaN(field.mmc[i]) ? null : field.mmc[i];
		const score = scoreFromMetrics({ corr, mmc, tc: null }, formula);
		if (score !== null) scores.push(score);
	}
	return scores;
}

/** How many models in the field have a score under `formula`. */
export function countScored(field: DecodedFieldMetrics, formula: ScoreFormula): number {
	return scoresIn(field, formula).length;
}

/**
 * Where a model with `own` metrics places in the field, and how many models were
 * scored at all. Null when the model has no score for the round.
 *
 * The model's metrics are rounded to Float32 first, because that is the
 * precision the field is stored at. Without it a model is compared against a
 * rounded copy of itself that can score fractionally higher, and the best model
 * in a round comes back ranked second.
 */
export function rankInField(
	field: DecodedFieldMetrics,
	own: MetricTriple,
	formula: ScoreFormula
): FieldRank | null {
	const asStored = (value: number | null): number | null =>
		value === null ? null : Math.fround(value);
	const score = scoreFromMetrics(
		{ corr: asStored(own.corr), mmc: asStored(own.mmc), tc: null },
		formula
	);
	if (score === null) return null;

	const scores = scoresIn(field, formula);
	return { rank: rankAmong(scores, score), totalModels: scores.length };
}
