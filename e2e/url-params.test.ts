import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * E2E: visiting /rankings or /models with the selection encoded in the URL
 * (tournament + models, optionally user) must (a) select the model(s) and
 * (b) auto-render the chart WITHOUT a manual "Calculate"/"Compare" click.
 *
 * The Worker API is fully mocked via page.route so the specs are deterministic
 * and never touch production. Patterns match on path suffix, so they work
 * regardless of the configured API host.
 */

const MODEL = 'ac_001';
const SECOND_MODEL = 'fncc_dl';
const USER = 'aas';

const TOURNAMENTS = [
	{ id: 8, name: 'Classic' },
	{ id: 11, name: 'Signals' },
	{ id: 12, name: 'Crypto' }
];

/** The selected-model chip (a <span>), distinct from the available-model add button. */
function chip(page: Page, text: string) {
	return page.locator('span').filter({ hasText: text }).first();
}

function json(route: Route, body: unknown) {
	return route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});
}

/** Tournament id from the request's query string (defaults to 8). */
function tournamentOf(url: string): number {
	return parseInt(new URL(url).searchParams.get('tournament') ?? '8', 10);
}

/** Model name from a /models/:name[/performance] path. */
function modelNameOf(url: string): string {
	const parts = new URL(url).pathname.split('/');
	const idx = parts.indexOf('models');
	return decodeURIComponent(parts[idx + 1] ?? '');
}

async function installMocks(page: Page) {
	// Current round
	await page.route('**/rankings/current-round*', (route) =>
		json(route, { tournament: tournamentOf(route.request().url()), round: 1279 })
	);

	// Per-model ranking history (rankings page chart). Non-null ranks so the
	// page treats the history as "rankable" and renders the chart.
	await page.route('**/rankings/model-rank*', (route) => {
		const url = route.request().url();
		const modelName = new URL(url).searchParams.get('modelName') ?? MODEL;
		json(route, {
			modelId: `id-${modelName}`,
			modelName,
			username: USER,
			rounds: [
				{ roundNumber: 1276, rank: 10, customScore: 0.03, totalModels: 1000 },
				{ roundNumber: 1277, rank: 8, customScore: 0.04, totalModels: 1000 },
				{ roundNumber: 1278, rank: 6, customScore: 0.05, totalModels: 1000 }
			]
		});
	});

	// User search (used when the URL has user=)
	await page.route('**/search/users*', (route) => json(route, [{ id: USER, username: USER }]));

	// A user's models
	await page.route('**/users/*/models*', (route) => {
		const t = tournamentOf(route.request().url());
		json(route, [
			{ id: `id-${MODEL}`, name: MODEL, username: USER, tournament: t, stake: 50, return1y: 10 },
			{ id: `id-${SECOND_MODEL}`, name: SECOND_MODEL, username: USER, tournament: t, stake: 1, return1y: 0 }
		]);
	});

	// /models/:name  and  /models/:name/performance
	await page.route('**/models/**', (route) => {
		const url = route.request().url();
		const t = tournamentOf(url);
		const name = modelNameOf(url);
		if (new URL(url).pathname.endsWith('/performance')) {
			json(route, {
				modelId: `id-${name}`,
				modelName: name,
				username: USER,
				stakeValue: 50,
				stakeInfo: null,
				rounds: [
					{
						roundNumber: 1278,
						roundOpenTime: '2026-05-30T12:00:00Z',
						roundResolved: true,
						correlation: 0.02,
						mmc: 0.01,
						fnc: 0.0,
						alpha: 0.02,
						mpc: 0.01,
						corrMultiplier: 0.5,
						selectedStakeValue: 50,
						payout: 1.0
					}
				]
			});
			return;
		}
		// model-by-name lookup
		json(route, { id: `id-${name}`, name, username: USER, tournament: t });
	});
}

test.describe('URL-driven selection + auto-render', () => {
	for (const t of TOURNAMENTS) {
		test(`rankings auto-renders for ${t.name} (single model)`, async ({ page }) => {
			await installMocks(page);
			await page.goto(
				`/rankings?tournament=${t.id}&startRound=1179&endRound=1278&user=${USER}&models=${MODEL}`
			);

			// Model selected from the URL
			await expect(chip(page, `${MODEL} (${USER})`)).toBeVisible();
			// Chart auto-rendered (no manual Calculate click)
			await expect(page.getByRole('heading', { name: 'Ranking History' })).toBeVisible();
		});

		test(`reviews auto-renders for ${t.name} (single model)`, async ({ page }) => {
			await installMocks(page);
			await page.goto(`/models?tournament=${t.id}&user=${USER}&models=${MODEL}`);

			await expect(chip(page, `${MODEL} (${USER})`)).toBeVisible();
			await expect(page.getByRole('heading', { name: 'Performance Over Time' })).toBeVisible();
		});
	}

	test('rankings auto-renders with multiple models', async ({ page }) => {
		await installMocks(page);
		await page.goto(
			`/rankings?tournament=12&startRound=1179&endRound=1278&models=${MODEL}%2C${SECOND_MODEL}&user=fish_n_chips`
		);

		await expect(chip(page, `${MODEL} (${USER})`)).toBeVisible();
		await expect(chip(page, `${SECOND_MODEL} (${USER})`)).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Ranking History' })).toBeVisible();
	});
});
