import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MetricBarComparison from './MetricBarComparison.svelte';

describe('MetricBarComparison', () => {
	const entries = [
		{ name: 'model_a', username: 'alice', value: 0.025 },
		{ name: 'model_b', username: 'bob', value: -0.01 },
		{ name: 'model_c', username: 'carol', value: null }
	];

	it('renders the metric label', async () => {
		render(MetricBarComparison, { label: 'Alpha', entries });
		await expect.element(page.getByText('Alpha')).toBeInTheDocument();
	});

	it('formats numeric values to the requested decimals', async () => {
		render(MetricBarComparison, { label: 'Score', entries, decimals: 4 });
		await expect.element(page.getByText('0.0250')).toBeInTheDocument();
		await expect.element(page.getByText('-0.0100')).toBeInTheDocument();
	});

	it('shows N/A for null values', async () => {
		render(MetricBarComparison, { label: 'MPC', entries });
		await expect.element(page.getByText('N/A')).toBeInTheDocument();
	});
});
