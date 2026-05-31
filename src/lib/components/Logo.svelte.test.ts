import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Logo from './Logo.svelte';

describe('Logo', () => {
	it('renders the numerdiff wordmark', async () => {
		render(Logo);
		await expect.element(page.getByText('numer')).toBeInTheDocument();
		await expect.element(page.getByText('diff')).toBeInTheDocument();
	});

	it('links to the home page by default', async () => {
		render(Logo);
		const link = page.getByRole('link', { name: /numerdiff/i });
		await expect.element(link).toHaveAttribute('href', '/');
	});

	it('honours a custom href', async () => {
		render(Logo, { href: '/models' });
		const link = page.getByRole('link', { name: /numerdiff/i });
		await expect.element(link).toHaveAttribute('href', '/models');
	});
});
