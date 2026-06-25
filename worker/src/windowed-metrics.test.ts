/**
 * Unit tests for the rolling-window metric averaging used by the rankings API.
 *
 * These are pure (no Worker/D1 needed) and cover the MMC20/CORR60-style trailing
 * average that backs the `window` query param on /rankings/model-rank and
 * /rankings/top-models. See buildWindowedMetrics in rankings-api.ts.
 */
import { describe, it, expect } from 'vitest';
import { buildWindowedMetrics, type RoundPerfRow } from './rankings-api';

const CLASSIC = 8;
const SIGNALS = 11;

/** Build a one-model field map: round → [row]. */
function fieldsFor(
	model: string,
	perRound: Array<{ round: number; corr?: number | null; mmc?: number | null; tc?: number | null }>
): Map<number, RoundPerfRow[]> {
	const map = new Map<number, RoundPerfRow[]>();
	for (const r of perRound) {
		map.set(r.round, [
			{
				model_name: model,
				corr: r.corr ?? null,
				mmc: r.mmc ?? null,
				tc: r.tc ?? null,
				alpha: null,
				mpc: null,
				stake_value: 1
			}
		]);
	}
	return map;
}

describe('buildWindowedMetrics', () => {
	it('window=1 reproduces the per-round metric exactly', () => {
		const fields = fieldsFor('m', [
			{ round: 10, corr: 0.02, mmc: 0.04 },
			{ round: 11, corr: 0.06, mmc: 0.08 }
		]);
		const w = buildWindowedMetrics(fields, CLASSIC, 1);
		expect(w.get('m')?.get(10)?.corr).toBeCloseTo(0.02, 10);
		expect(w.get('m')?.get(10)?.mmc).toBeCloseTo(0.04, 10);
		expect(w.get('m')?.get(11)?.corr).toBeCloseTo(0.06, 10);
		expect(w.get('m')?.get(11)?.mmc).toBeCloseTo(0.08, 10);
	});

	it('averages over the trailing window (by round number)', () => {
		const fields = fieldsFor('m', [
			{ round: 1, corr: 0.0, mmc: 0.0 },
			{ round: 2, corr: 0.2, mmc: 0.4 },
			{ round: 3, corr: 0.4, mmc: 0.8 }
		]);
		const w = buildWindowedMetrics(fields, CLASSIC, 2);
		// round 3 averages rounds {2,3}: corr=(0.2+0.4)/2=0.3, mmc=(0.4+0.8)/2=0.6
		expect(w.get('m')?.get(3)?.corr).toBeCloseTo(0.3, 10);
		expect(w.get('m')?.get(3)?.mmc).toBeCloseTo(0.6, 10);
		// round 2 averages {1,2}: corr=0.1, mmc=0.2
		expect(w.get('m')?.get(2)?.corr).toBeCloseTo(0.1, 10);
	});

	it('measures the window by round number, so gaps shrink the sample', () => {
		// Rounds 10 and 13 only; with window=3 round 13 sees just {13} (11,12 absent
		// and 10 is outside [11,13]).
		const fields = fieldsFor('m', [
			{ round: 10, corr: 1.0 },
			{ round: 13, corr: 0.1 }
		]);
		const w = buildWindowedMetrics(fields, CLASSIC, 3);
		expect(w.get('m')?.get(13)?.corr).toBeCloseTo(0.1, 10);
		// window=4 → round 13 sees {10,13}: (1.0+0.1)/2 = 0.55
		const w4 = buildWindowedMetrics(fields, CLASSIC, 4);
		expect(w4.get('m')?.get(13)?.corr).toBeCloseTo(0.55, 10);
	});

	it('skips null metric values within the window', () => {
		const fields = fieldsFor('m', [
			{ round: 1, corr: 0.2, mmc: null },
			{ round: 2, corr: null, mmc: 0.6 },
			{ round: 3, corr: 0.4, mmc: 0.2 }
		]);
		const w = buildWindowedMetrics(fields, CLASSIC, 3);
		// corr over {0.2, 0.4} = 0.3; mmc over {0.6, 0.2} = 0.4
		expect(w.get('m')?.get(3)?.corr).toBeCloseTo(0.3, 10);
		expect(w.get('m')?.get(3)?.mmc).toBeCloseTo(0.4, 10);
	});

	it('returns null for a metric with no non-null value in the window', () => {
		const fields = fieldsFor('m', [
			{ round: 1, corr: null, mmc: 0.5 },
			{ round: 2, corr: null, mmc: 0.7 }
		]);
		const w = buildWindowedMetrics(fields, CLASSIC, 2);
		expect(w.get('m')?.get(2)?.corr).toBeNull();
		expect(w.get('m')?.get(2)?.mmc).toBeCloseTo(0.6, 10);
	});

	it('uses alpha/mpc for Signals (tournament 11)', () => {
		const map = new Map<number, RoundPerfRow[]>([
			[1, [{ model_name: 'm', corr: 0.9, mmc: 0.9, tc: null, alpha: 0.2, mpc: 0.4, stake_value: 1 }]],
			[2, [{ model_name: 'm', corr: 0.9, mmc: 0.9, tc: null, alpha: 0.4, mpc: 0.8, stake_value: 1 }]]
		]);
		const w = buildWindowedMetrics(map, SIGNALS, 2);
		// corr slot carries alpha avg (0.3), mmc slot carries mpc avg (0.6)
		expect(w.get('m')?.get(2)?.corr).toBeCloseTo(0.3, 10);
		expect(w.get('m')?.get(2)?.mmc).toBeCloseTo(0.6, 10);
	});
});
