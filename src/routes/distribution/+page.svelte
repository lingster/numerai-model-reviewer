<script lang="ts">
	import { onMount } from 'svelte';
	import Autocomplete from '$lib/components/Autocomplete.svelte';
	import DistributionChart from '$lib/components/DistributionChart.svelte';
	import { NumeraiAPI } from '$lib/numerai-api.js';
	import { config } from '$lib/config.js';
	import {
		getCurrentRound,
		getRoundDistribution,
		getDefaultFormulaForTournament
	} from '$lib/rankings-api.js';
	import type { NumeraiUser, NumeraiModel, RoundDistribution, ScoreFormula } from '$lib/types.js';
	import {
		getSelectedTournament,
		setSelectedTournament,
		TOURNAMENTS,
		TOURNAMENT_INFO,
		type TournamentId
	} from '$lib/utils/storage.js';
	import {
		sortDistributionModels,
		type DistributionSortKey,
		type SortDirection
	} from '$lib/utils/sort-distribution.js';
	import { replaceState } from '$app/navigation';
	import { browser } from '$app/environment';

	let numeraiApi: NumeraiAPI;

	// User search
	let userSearchQuery = $state('');
	let userSearchResults = $state<NumeraiUser[]>([]);
	let userSearchLoading = $state(false);
	let selectedUser = $state<NumeraiUser | null>(null);
	let userModels = $state<NumeraiModel[]>([]);
	let modelLoadError = $state<string | null>(null);

	// Tournament selection
	let selectedTournament = $state<TournamentId>(TOURNAMENTS.CLASSIC);
	const themeClass = $derived(TOURNAMENT_INFO[selectedTournament].theme);
	const isSignals = $derived(selectedTournament === TOURNAMENTS.SIGNALS);
	const metric1Label = $derived(isSignals ? 'Alpha' : 'Corr');
	const metric2Label = $derived(isSignals ? 'MPC' : 'MMC');

	// Round + formula
	let currentRound = $state(0);
	let selectedRound = $state(0);
	let scoreFormula = $state<ScoreFormula>(getDefaultFormulaForTournament(TOURNAMENTS.CLASSIC));
	const formulaText = $derived(
		`${scoreFormula.corrWeight}×${metric1Label} + ${scoreFormula.mmcWeight}×${metric2Label}`
	);

	// Distribution data
	let distribution = $state<RoundDistribution | null>(null);
	let loadingDistribution = $state(false);
	let distributionError = $state<string | null>(null);

	// Table sorting — default to rank ascending (best model first)
	let sortKey = $state<DistributionSortKey>('rank');
	let sortDirection = $state<SortDirection>('asc');
	const sortedModels = $derived(
		distribution ? sortDistributionModels(distribution.models, sortKey, sortDirection) : []
	);

	function toggleSort(key: DistributionSortKey) {
		if (sortKey === key) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			// Metrics read best-first as descending; rank/name as ascending.
			sortDirection = key === 'rank' || key === 'modelName' ? 'asc' : 'desc';
		}
	}

	function sortIndicator(key: DistributionSortKey): string {
		if (sortKey !== key) return '';
		return sortDirection === 'asc' ? ' ▲' : ' ▼';
	}

	onMount(async () => {
		numeraiApi = new NumeraiAPI();

		const url = new URL(window.location.href);
		const tournamentParam = url.searchParams.get('tournament');
		if (tournamentParam) {
			const parsed = parseInt(tournamentParam, 10) as TournamentId;
			if (
				parsed === TOURNAMENTS.CLASSIC ||
				parsed === TOURNAMENTS.SIGNALS ||
				parsed === TOURNAMENTS.CRYPTO
			) {
				selectedTournament = parsed;
				setSelectedTournament(parsed);
			}
		} else {
			selectedTournament = getSelectedTournament();
		}

		scoreFormula = getDefaultFormulaForTournament(selectedTournament);

		try {
			currentRound = await getCurrentRound(selectedTournament);
			selectedRound = currentRound - 1;
		} catch (error) {
			console.error('Error fetching current round:', error);
		}

		const roundParam = url.searchParams.get('round');
		if (roundParam) {
			const parsed = parseInt(roundParam, 10);
			if (parsed > 0) selectedRound = parsed;
		}

		const userParam = url.searchParams.get('user');
		if (userParam) {
			userSearchQuery = userParam;
			await searchUsers();
			const user = userSearchResults.find(
				(u) => u.username.toLowerCase() === userParam.toLowerCase()
			);
			if (user) await selectUser(user);
		}
	});

	// Debounced user search
	let searchTimeout: number;
	$effect(() => {
		clearTimeout(searchTimeout);
		if (userSearchQuery.length >= 2) {
			searchTimeout = setTimeout(() => searchUsers(), 300);
		} else {
			userSearchResults = [];
		}
	});

	async function searchUsers() {
		if (!numeraiApi) return;
		userSearchLoading = true;
		try {
			const results = await numeraiApi.searchUsers(userSearchQuery);
			userSearchResults = results
				.slice()
				.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
		} catch (error) {
			console.error('Error searching users:', error);
			userSearchResults = [];
		}
		userSearchLoading = false;
	}

	async function selectUser(user: NumeraiUser) {
		if (!user?.username) return;
		selectedUser = user;
		userSearchQuery = user.username;
		modelLoadError = null;
		distribution = null;

		try {
			userModels = await numeraiApi.getUserModels(user.username, selectedTournament);
			if (userModels.length === 0) {
				modelLoadError = `No ${TOURNAMENT_INFO[selectedTournament].name} models found for user "${user.username}"`;
			}
		} catch (error) {
			userModels = [];
			modelLoadError = `Failed to load models: ${error instanceof Error ? error.message : 'Unknown error'}`;
		}

		updateUrlParams();
		if (userModels.length > 0) {
			await loadDistribution({ findLatestWithData: true });
		}
	}

	function clearUserSelection() {
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		userModels = [];
		modelLoadError = null;
		distribution = null;
		updateUrlParams();
	}

	/**
	 * Load the distribution for the selected round. With findLatestWithData the
	 * search steps back from the selected round until it finds one with a
	 * populated field — the latest round is often still unresolved/empty.
	 */
	async function loadDistribution(opts: { findLatestWithData?: boolean } = {}) {
		if (userModels.length === 0 || selectedRound <= 0) return;

		loadingDistribution = true;
		distributionError = null;
		const modelNames = userModels.map((m) => m.name);
		const MAX_LOOKBACK = 10;

		try {
			let round = selectedRound;
			let result = await getRoundDistribution(round, scoreFormula, selectedTournament, modelNames);
			if (opts.findLatestWithData) {
				for (let back = 1; result.totalModels === 0 && back <= MAX_LOOKBACK && round - 1 > 0; back++) {
					round -= 1;
					result = await getRoundDistribution(round, scoreFormula, selectedTournament, modelNames);
				}
				selectedRound = round;
			}
			distribution = result;
			if (result.totalModels === 0) {
				distributionError = `No precomputed data for Round ${round}. Try an earlier round.`;
			} else if (result.models.length === 0) {
				distributionError = `None of ${selectedUser?.username}'s models have scores in Round ${round}.`;
			}
		} catch (error) {
			console.error('Error loading distribution:', error);
			distribution = null;
			distributionError = `Failed to load distribution: ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			loadingDistribution = false;
			updateUrlParams();
		}
	}

	function switchTournament(tournament: TournamentId) {
		if (tournament === selectedTournament) return;
		selectedTournament = tournament;
		setSelectedTournament(tournament);
		scoreFormula = getDefaultFormulaForTournament(tournament);

		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		userModels = [];
		modelLoadError = null;
		distribution = null;
		distributionError = null;

		getCurrentRound(tournament)
			.then((round) => {
				currentRound = round;
				selectedRound = round - 1;
			})
			.catch(() => {});

		updateUrlParams();
	}

	function updateFormula(field: keyof ScoreFormula, value: number) {
		scoreFormula = { ...scoreFormula, [field]: value };
	}

	function resetFormula() {
		scoreFormula = getDefaultFormulaForTournament(selectedTournament);
	}

	function updateUrlParams() {
		if (!browser) return;
		const url = new URL(window.location.href);
		url.searchParams.set('tournament', selectedTournament.toString());
		if (selectedUser?.username) {
			url.searchParams.set('user', selectedUser.username);
		} else {
			url.searchParams.delete('user');
		}
		if (selectedRound > 0) {
			url.searchParams.set('round', selectedRound.toString());
		}
		replaceState(url.toString(), {});
	}
</script>

<svelte:head>
	<title>Model Distribution - {TOURNAMENT_INFO[selectedTournament].name} | Numerai Model Reviewer</title>
</svelte:head>

<div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 {themeClass}">
	<div class="mb-8">
		<h1 class="text-3xl font-bold retro-text-accent uppercase tracking-wider">MODEL DISTRIBUTION</h1>
		<p class="mt-2 retro-text-secondary">
			See where your models sit in a round's score distribution against the whole field
		</p>
	</div>

	<!-- Tournament Tabs -->
	<div class="tournament-tabs">
		{#if config.features.enableClassic}
			<button
				class="tournament-tab tab-classic"
				class:active={selectedTournament === TOURNAMENTS.CLASSIC}
				onclick={() => switchTournament(TOURNAMENTS.CLASSIC)}
			>
				Classic
			</button>
		{/if}
		{#if config.features.enableSignals}
			<button
				class="tournament-tab tab-signals"
				class:active={selectedTournament === TOURNAMENTS.SIGNALS}
				onclick={() => switchTournament(TOURNAMENTS.SIGNALS)}
			>
				Signals
			</button>
		{/if}
		{#if config.features.enableCrypto}
			<button
				class="tournament-tab tab-crypto"
				class:active={selectedTournament === TOURNAMENTS.CRYPTO}
				onclick={() => switchTournament(TOURNAMENTS.CRYPTO)}
			>
				Crypto
			</button>
		{/if}
	</div>

	<!-- User + Round + Formula -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Your Models</h2>

		<div class="grid gap-4 md:grid-cols-3">
			<!-- User Search -->
			<div>
				<div class="flex items-center justify-between">
					<label for="userSearch" class="block text-sm font-medium retro-text-primary">Username</label>
					{#if userSearchLoading}
						<span class="text-xs retro-text-accent">Searching...</span>
					{:else if selectedUser && userModels.length > 0}
						<span class="text-xs retro-text-success">{userModels.length} models</span>
					{/if}
				</div>
				<div class="relative mt-1">
					<Autocomplete
						id="userSearch"
						bind:value={userSearchQuery}
						options={userSearchResults.map((user) => ({
							id: user.id,
							label: user.username,
							value: user
						}))}
						placeholder="Type username to search (2+ chars)..."
						loading={userSearchLoading}
						selectOnClick={Boolean(selectedUser)}
						onselect={selectUser}
					/>
					{#if selectedUser}
						<button
							onclick={clearUserSelection}
							class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 retro-text-secondary hover:retro-bg-secondary"
							title="Change user"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
							</svg>
						</button>
					{/if}
				</div>
				{#if modelLoadError}
					<p class="mt-1 text-sm retro-text-error">{modelLoadError}</p>
				{/if}
			</div>

			<!-- Round -->
			<div>
				<label for="roundInput" class="block text-sm font-medium retro-text-primary">Round</label>
				<input
					id="roundInput"
					type="number"
					bind:value={selectedRound}
					min="1"
					max={Math.max(currentRound - 1, 1)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
				{#if currentRound > 0}
					<p class="mt-1 text-xs retro-text-secondary">Current round: {currentRound}</p>
				{/if}
			</div>

			<!-- Load -->
			<div class="flex items-end">
				<button
					onclick={() => loadDistribution()}
					disabled={userModels.length === 0 || loadingDistribution}
					class="retro-button w-full rounded-md px-6 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
				>
					{loadingDistribution ? 'Loading...' : 'Load Distribution'}
				</button>
			</div>
		</div>

		<!-- Score Formula -->
		<div class="mt-6 border-t border-[var(--retro-light-grey)] pt-4">
			<div class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-medium retro-text-primary uppercase">
					Score Formula: <span class="retro-text-accent">{formulaText}</span>
				</h3>
				<button onclick={resetFormula} class="text-sm retro-text-accent hover:underline">
					Reset to Default
				</button>
			</div>
			<div class="grid gap-4 md:grid-cols-2 max-w-md">
				<div>
					<label for="corrWeight" class="block text-xs retro-text-secondary">{metric1Label} Weight</label>
					<input
						id="corrWeight"
						type="number"
						step="0.05"
						value={scoreFormula.corrWeight}
						onchange={(e) => updateFormula('corrWeight', parseFloat(e.currentTarget.value) || 0)}
						class="retro-input mt-1 w-full rounded-md px-3 py-1.5 text-sm"
					/>
				</div>
				<div>
					<label for="mmcWeight" class="block text-xs retro-text-secondary">{metric2Label} Weight</label>
					<input
						id="mmcWeight"
						type="number"
						step="0.05"
						value={scoreFormula.mmcWeight}
						onchange={(e) => updateFormula('mmcWeight', parseFloat(e.currentTarget.value) || 0)}
						class="retro-input mt-1 w-full rounded-md px-3 py-1.5 text-sm"
					/>
				</div>
			</div>
		</div>

		{#if distributionError}
			<div class="mt-4 rounded-md bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] p-4">
				<p class="text-sm retro-text-warning">{distributionError}</p>
			</div>
		{/if}
	</div>

	<!-- Distribution Chart -->
	{#if distribution && distribution.totalModels > 0}
		<div class="mb-6 rounded-lg retro-card p-6">
			<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="text-lg font-medium retro-text-primary uppercase">
					Round {distribution.round} Score Distribution
				</h2>
				<span class="text-sm retro-text-secondary">
					{distribution.totalModels.toLocaleString()} models ({distribution.stakedModels.toLocaleString()} staked)
				</span>
			</div>
			<DistributionChart
				bins={distribution.bins}
				myModels={distribution.models}
				scoreLabel="Score ({formulaText})"
			/>
		</div>
	{/if}

	<!-- Models Table -->
	{#if distribution && distribution.models.length > 0}
		<div class="rounded-lg retro-card">
			<div class="px-6 py-4 border-b retro-border-secondary border-2">
				<h2 class="text-lg font-medium retro-text-primary uppercase">
					{selectedUser?.username}'s Models — Round {distribution.round}
				</h2>
				<p class="text-sm retro-text-secondary mt-1">
					Score = {formulaText} · ranked against all {distribution.totalModels.toLocaleString()} models · click a column to sort
				</p>
			</div>

			<div class="overflow-x-auto">
				<table class="min-w-full divide-y retro-border-secondary border-2">
					<thead class="retro-bg-secondary">
						<tr>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('modelName')}>
									Model{sortIndicator('modelName')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('corr')}>
									{metric1Label}{sortIndicator('corr')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('mmc')}>
									{metric2Label}{sortIndicator('mmc')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('score')}>
									Score{sortIndicator('score')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('rank')}>
									Rank{sortIndicator('rank')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('percentile')}>
									Percentile{sortIndicator('percentile')}
								</button>
							</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">
								<button class="uppercase hover:retro-text-accent" onclick={() => toggleSort('stakeValue')}>
									At Stake{sortIndicator('stakeValue')}
								</button>
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
						{#each sortedModels as model (model.modelName)}
							<tr>
								<td class="whitespace-nowrap px-4 py-3 text-sm font-medium retro-text-primary">
									{model.modelName}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.corr !== null}
										<span class={model.corr > 0 ? 'retro-text-success' : 'retro-text-error'}>
											{model.corr.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.mmc !== null}
										<span class={model.mmc > 0 ? 'retro-text-success' : 'retro-text-error'}>
											{model.mmc.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm font-bold">
									<span class={model.score > 0 ? 'retro-text-success' : 'retro-text-error'}>
										{model.score.toFixed(4)}
									</span>
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm font-bold retro-text-accent">
									#{model.rank.toLocaleString()}
									<span class="font-normal retro-text-secondary">/ {distribution.totalModels.toLocaleString()}</span>
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm retro-text-primary">
									{model.percentile.toFixed(1)}%
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.staked && model.stakeValue !== null}
										<span class="retro-text-primary">{model.stakeValue.toFixed(2)} NMR</span>
									{:else}
										<span class="retro-text-secondary">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else if !selectedUser && !loadingDistribution}
		<div class="rounded-lg retro-card p-8 text-center retro-text-secondary">
			Search for your username above to see where your models land in the round's score distribution.
		</div>
	{/if}
</div>
