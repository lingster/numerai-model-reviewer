import { describe, it, expect } from 'vitest';
import { paginateModels } from './paginate-models.js';
import type { RoundModelScore } from '$lib/types.js';

function makeModels(names: string[]): RoundModelScore[] {
	return names.map((modelName, i) => ({
		modelId: '',
		modelName,
		username: '',
		roundNumber: 1,
		corr: 0,
		mmc: 0,
		tc: null,
		stakeValue: null,
		customScore: 0,
		rank: i + 1
	}));
}

describe('paginateModels', () => {
	const models = makeModels(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);

	it('returns the first page with no query', () => {
		const r = paginateModels(models, '', 1, 2);
		expect(r.items.map((m) => m.modelName)).toEqual(['alpha', 'beta']);
		expect(r.totalFiltered).toBe(5);
		expect(r.totalPages).toBe(3);
		expect(r.page).toBe(1);
	});

	it('returns the requested page', () => {
		const r = paginateModels(models, '', 2, 2);
		expect(r.items.map((m) => m.modelName)).toEqual(['gamma', 'delta']);
		expect(r.page).toBe(2);
	});

	it('filters by case-insensitive substring of model name', () => {
		const r = paginateModels(makeModels(['Alpha', 'BetaAL', 'gamma']), 'al', 1, 10);
		expect(r.items.map((m) => m.modelName)).toEqual(['Alpha', 'BetaAL']);
		expect(r.totalFiltered).toBe(2);
		expect(r.totalPages).toBe(1);
	});

	it('trims the query', () => {
		const r = paginateModels(models, '  beta  ', 1, 10);
		expect(r.items.map((m) => m.modelName)).toEqual(['beta']);
	});

	it('clamps page above the last page to the last page', () => {
		const r = paginateModels(models, '', 99, 2);
		expect(r.page).toBe(3);
		expect(r.items.map((m) => m.modelName)).toEqual(['epsilon']);
	});

	it('clamps page below 1 to page 1', () => {
		const r = paginateModels(models, '', 0, 2);
		expect(r.page).toBe(1);
		expect(r.items.map((m) => m.modelName)).toEqual(['alpha', 'beta']);
	});

	it('reports at least one page and an empty item list when nothing matches', () => {
		const r = paginateModels(models, 'zzz', 1, 2);
		expect(r.items).toEqual([]);
		expect(r.totalFiltered).toBe(0);
		expect(r.totalPages).toBe(1);
		expect(r.page).toBe(1);
	});

	it('handles an empty model list', () => {
		const r = paginateModels([], '', 1, 10);
		expect(r.items).toEqual([]);
		expect(r.totalFiltered).toBe(0);
		expect(r.totalPages).toBe(1);
	});
});
