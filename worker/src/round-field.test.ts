/**
 * A round's field: every scored model's metrics for one round, stored as a
 * single row so ranking a model costs one read instead of one read per model.
 *
 * Metrics are stored, not scores, so a payout-formula change (Classic moved to
 * 3xCORR60 + 15xMMC60 on 28 Aug 2026) and the UI's adjustable weights both work
 * against stored history rather than invalidating it.
 *
 * Identity is deliberately absent: the field is an unordered bag of metric
 * pairs. Ranking needs the distribution plus the one model's own metrics, which
 * come from its own model_performances rows.
 */
import { describe, expect, it } from 'vitest';
import { decodeFieldMetrics, encodeFieldMetrics, rankInField, type FieldMetrics } from './round-field';
import { pickMetrics, rankAmong, rankSortedScores, scoreFromMetrics, type MetricTriple, type ScoreFormula } from './ranking';
import type { RoundPerfRow } from './perf-queries';

const FORMULA: ScoreFormula = { corrWeight: 0.75, mmcWeight: 2.25, tcWeight: 0 };

const metrics = (corr: number | null, mmc: number | null): MetricTriple => ({ corr, mmc, tc: null });

const row = (model_name: string, corr: number | null, mmc: number | null): RoundPerfRow => ({
	model_name,
	corr,
	mmc,
	tc: null,
	alpha: null,
	mpc: null,
	stake_value: 1
});

describe('encodeFieldMetrics / decodeFieldMetrics', () => {
	it('round-trips metric pairs exactly', () => {
		const corr = [0.0123, -0.05, 0.4];
		const mmc = [-0.001, 0.02, 0.0009];
		const decoded = decodeFieldMetrics(encodeFieldMetrics({ corr, mmc } satisfies FieldMetrics));
		// Stored at the precision SQLite holds them at, so nothing is lost: two
		// competitors can never swap order through storage.
		expect(Array.from(decoded.corr)).toEqual(corr);
		expect(Array.from(decoded.mmc)).toEqual(mmc);
	});

	it('keeps scores that differ far below Float32 resolution in order', () => {
		// Packed as Float32 these collapse to the same value, and the two models
		// tie instead of ordering.
		const a = 0.0123456789;
		const b = a + 1e-12;
		const decoded = decodeFieldMetrics(encodeFieldMetrics({ corr: [a, b], mmc: [0, 0] }));
		expect(decoded.corr[1]).toBeGreaterThan(decoded.corr[0]);
	});

	it('keeps a missing metric missing rather than turning it into zero', () => {
		// A model scored on one metric but not the other must not rank as if the
		// missing one were 0 — that is a real score in this scale.
		const decoded = decodeFieldMetrics(encodeFieldMetrics({ corr: [null, 0.01], mmc: [0.02, null] }));
		expect(decoded.corr[0]).toBeNaN();
		expect(decoded.mmc[1]).toBeNaN();
		expect(decoded.corr[1]).toBeCloseTo(0.01, 6);
	});

	it('rejects metric arrays of different lengths, which would misalign pairs', () => {
		expect(() => encodeFieldMetrics({ corr: [0.1, 0.2], mmc: [0.1] })).toThrow(/length/i);
	});

	it('handles an empty field', () => {
		const decoded = decodeFieldMetrics(encodeFieldMetrics({ corr: [], mmc: [] }));
		expect(decoded.corr).toHaveLength(0);
	});

	it('stores a realistic field compactly', () => {
		const size = 4600;
		const encoded = encodeFieldMetrics({
			corr: Array.from({ length: size }, (_, i) => i / 100000),
			mmc: Array.from({ length: size }, (_, i) => -i / 100000)
		});
		const bytes = encoded.corr.length + encoded.mmc.length;
		// Two base64 Float64 arrays: 16 bytes per model before base64's 4/3, so a
		// round of ~4,600 models is ~96KB — one D1 row, one read.
		expect(bytes).toBeLessThan(size * 24);
	});
});

describe('rankInField', () => {
	const field: FieldMetrics = {
		corr: [0.05, 0.01, -0.02, 0.03],
		mmc: [0.01, 0.02, 0.0, -0.01]
	};
	const encoded = encodeFieldMetrics(field);

	it('ranks the best model first', () => {
		expect(rankInField(decodeFieldMetrics(encoded), metrics(0.05, 0.01), FORMULA)).toEqual({
			rank: 1,
			totalModels: 4
		});
	});

	it('ranks the worst model last, not past the end of the field', () => {
		expect(rankInField(decodeFieldMetrics(encoded), metrics(-0.02, 0.0), FORMULA)).toEqual({
			rank: 4,
			totalModels: 4
		});
	});

	it('returns null for a model with no metrics in the round', () => {
		expect(rankInField(decodeFieldMetrics(encoded), metrics(null, null), FORMULA)).toBeNull();
	});

	it('ranks by how many models score above, not by position', () => {
		const placed = rankInField(decodeFieldMetrics(encoded), metrics(0.01, 0.02), FORMULA)!;
		expect(placed).toEqual({ rank: 2, totalModels: 4 });
	});

	it('counts only models that have a score', () => {
		const withGaps = encodeFieldMetrics({ corr: [0.05, null, 0.01], mmc: [0.01, null, 0.02] });
		const { totalModels } = rankInField(decodeFieldMetrics(withGaps), metrics(0.05, 0.01), FORMULA)!;
		expect(totalModels).toBe(2);
	});

	it('follows the weights it is given, so the UI sliders keep working', () => {
		const mmcHeavy: ScoreFormula = { corrWeight: 0, mmcWeight: 1, tcWeight: 0 };
		const decoded = decodeFieldMetrics(encoded);
		// Under mmc-only weights the model with the highest mmc (0.02) is first.
		expect(rankInField(decoded, metrics(0.01, 0.02), mmcHeavy)!.rank).toBe(1);
	});
});

describe('ranking from a stored field matches ranking the raw rows', () => {
	// The live path sorts the scored field and takes the model's index; the
	// stored path counts better scores. They must agree, or a model's rank would
	// jump when a round becomes covered by the stored fields.
	const rows: RoundPerfRow[] = [
		row('alpha_model', 0.05, 0.01),
		row('bravo_model', 0.01, 0.02),
		row('charlie_model', -0.02, 0.0),
		row('delta_model', 0.03, -0.01),
		row('echo_model', null, null)
	];
	const CLASSIC = 8;

	const liveRank = (target: string) => {
		const scored = rows
			.map((r) => ({ name: r.model_name, score: scoreFromMetrics(pickMetrics(r, CLASSIC), FORMULA) }))
			.filter((s): s is { name: string; score: number } => s.score !== null)
			.sort((a, b) => b.score - a.score);
		return {
			rank: scored.findIndex((s) => s.name === target) + 1,
			totalModels: scored.length
		};
	};

	it.each(['alpha_model', 'bravo_model', 'charlie_model', 'delta_model'])(
		'agrees for %s',
		(target) => {
			const stored = decodeFieldMetrics(
				encodeFieldMetrics({
					corr: rows.map((r) => pickMetrics(r, CLASSIC).corr),
					mmc: rows.map((r) => pickMetrics(r, CLASSIC).mmc)
				})
			);
			const own = rows.find((r) => r.model_name === target)!;
			expect(rankInField(stored, pickMetrics(own, CLASSIC), FORMULA)).toEqual(liveRank(target));
		}
	);
});

describe('rankSortedScores', () => {
	it('gives competition ranks, so equal scores share one', () => {
		expect(rankSortedScores([0.5, 0.3, 0.3, 0.1])).toEqual([1, 2, 2, 4]);
	});

	it('agrees with rankAmong, which ranks a model against a stored field', () => {
		const scores = [0.5, 0.3, 0.3, 0.1];
		expect(rankSortedScores(scores)).toEqual(scores.map((s) => rankAmong(scores, s)));
	});

	it('handles an empty field', () => {
		expect(rankSortedScores([])).toEqual([]);
	});
});
