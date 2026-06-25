import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RankingsChart from './RankingsChart.svelte';
import type { ModelRankingHistory } from '$lib/types.js';

const histories: ModelRankingHistory[] = [
	{
		modelId: 'a',
		modelName: 'model_a',
		username: 'alice',
		rankings: [
			{ roundNumber: 1179, rank: 5, corr: 0.02, mmc: 0.01, customScore: 0.02, totalModels: 100 },
			{ roundNumber: 1180, rank: 3, corr: 0.03, mmc: 0.02, customScore: 0.03, totalModels: 100 }
		]
	},
	{
		modelId: 'b',
		modelName: 'model_b',
		username: 'bob',
		rankings: [
			{ roundNumber: 1179, rank: 12, corr: 0.01, mmc: 0.005, customScore: 0.01, totalModels: 100 },
			{ roundNumber: 1180, rank: 9, corr: 0.015, mmc: 0.008, customScore: 0.015, totalModels: 100 }
		]
	}
];

describe('RankingsChart', () => {
	// Regression: the visibility-initialising $effect used to read and write the
	// same modelVisibility state, looping until effect_update_depth_exceeded.
	// Rendering with non-empty histories must settle without throwing.
	it('renders model legend without an effect loop', async () => {
		render(RankingsChart, { rankingHistories: histories, startRound: 1179, endRound: 1180 });
		await expect.element(page.getByText('model_a')).toBeInTheDocument();
		await expect.element(page.getByText('model_b')).toBeInTheDocument();
	});
});
