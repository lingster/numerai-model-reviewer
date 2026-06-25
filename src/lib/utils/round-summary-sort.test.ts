import { describe, expect, it } from 'vitest';
import type { RoundModelScore } from '$lib/types.js';
import { defaultDirFor, sortRoundModels } from './round-summary-sort.js';

function m(name: string, fields: Partial<RoundModelScore>): RoundModelScore {
	return {
		modelId: '',
		modelName: name,
		username: 'u',
		roundNumber: 1000,
		corr: 0,
		mmc: 0,
		tc: null,
		stakeValue: null,
		customScore: 0,
		rank: 1,
		totalModels: 100,
		...fields
	};
}

describe('sortRoundModels', () => {
	const models = [
		m('beta', { mmc: 0.02, rank: 3 }),
		m('alpha', { mmc: 0.05, rank: 1 }),
		m('gamma', { mmc: null, rank: 2 })
	];

	it('sorts by metric descending (highest first)', () => {
		expect(sortRoundModels(models, 'metric2', 'desc').map((x) => x.modelName)).toEqual([
			'alpha',
			'beta',
			'gamma' // null last
		]);
	});

	it('sorts by metric ascending with nulls still last', () => {
		expect(sortRoundModels(models, 'metric2', 'asc').map((x) => x.modelName)).toEqual([
			'beta',
			'alpha',
			'gamma' // null last regardless of direction
		]);
	});

	it('sorts by model name', () => {
		expect(sortRoundModels(models, 'model', 'asc').map((x) => x.modelName)).toEqual([
			'alpha',
			'beta',
			'gamma'
		]);
	});

	it('sorts by rank ascending (best first)', () => {
		expect(sortRoundModels(models, 'rank', 'asc').map((x) => x.rank)).toEqual([1, 2, 3]);
	});

	it('does not mutate the input array', () => {
		const copy = [...models];
		sortRoundModels(models, 'rank', 'desc');
		expect(models).toEqual(copy);
	});
});

describe('defaultDirFor', () => {
	it('defaults text/rank to asc and metrics to desc', () => {
		expect(defaultDirFor('model')).toBe('asc');
		expect(defaultDirFor('rank')).toBe('asc');
		expect(defaultDirFor('metric1')).toBe('desc');
		expect(defaultDirFor('percentile')).toBe('desc');
	});
});
