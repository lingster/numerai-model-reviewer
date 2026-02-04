<script lang="ts">
	import { onMount } from 'svelte';
	import Autocomplete from '$lib/components/Autocomplete.svelte';
	import RankingsChart from '$lib/components/RankingsChart.svelte';
	import { NumeraiAPI } from '$lib/numerai-api.js';
	import { config } from '$lib/config.js';
	import {
		calculateModelRankings,
		getTopModelsForRound,
		getCurrentRound,
		DEFAULT_SCORE_FORMULA,
		calculateCustomScore
	} from '$lib/rankings-api.js';
	import type { NumeraiUser, NumeraiModel, ModelRankingHistory, ScoreFormula, RoundModelScore } from '$lib/types.js';
	import {
		getSelectedTournament,
		setSelectedTournament,
		TOURNAMENTS,
		TOURNAMENT_INFO,
		type TournamentId
	} from '$lib/utils/storage.js';
	import { replaceState } from '$app/navigation';
	import { browser } from '$app/environment';

	let numeraiApi: NumeraiAPI;

	// Search states
	let userSearchQuery = $state('');
	let userSearchResults = $state<NumeraiUser[]>([]);
	let userSearchLoading = $state(false);
	let selectedUser = $state<NumeraiUser | null>(null);

	let modelSearchQuery = $state('');
	let availableModels = $state<NumeraiModel[]>([]);
	let modelSearchLoading = $state(false);
	let modelLoadError = $state<string | null>(null);
	let modelSearchResults = $state<NumeraiModel[]>([]);

	// Selected models
	let selectedModels = $state<NumeraiModel[]>([]);

	// Tournament selection (Classic and Crypto only)
	let selectedTournament = $state<TournamentId>(TOURNAMENTS.CLASSIC);
	const themeClass = $derived(TOURNAMENT_INFO[selectedTournament].theme);

	// Round range
	let currentRound = $state(0);
	let startRound = $state(0);
	let endRound = $state(0);

	// Score formula
	let scoreFormula = $state<ScoreFormula>({ ...DEFAULT_SCORE_FORMULA });

	// Rankings data
	let rankingHistories = $state<ModelRankingHistory[]>([]);
	let topModels = $state<RoundModelScore[]>([]);
	let loadingRankings = $state(false);
	let rankingsError = $state<string | null>(null);
	let loadingProgress = $state({ stage: '', loaded: 0, total: 0 });

	// Selected round for top 10 table
	let selectedRoundForTop10 = $state(0);

	onMount(async () => {
		numeraiApi = new NumeraiAPI();

		// Load tournament from URL or localStorage
		const url = new URL(window.location.href);
		const tournamentParam = url.searchParams.get('tournament');
		if (tournamentParam) {
			const parsedTournament = parseInt(tournamentParam, 10) as TournamentId;
			// Only allow Classic or Crypto for rankings
			if (parsedTournament === TOURNAMENTS.CLASSIC || parsedTournament === TOURNAMENTS.CRYPTO) {
				selectedTournament = parsedTournament;
				setSelectedTournament(parsedTournament);
			}
		} else {
			const stored = getSelectedTournament();
			// Default to Classic if Signals is stored
			selectedTournament = stored === TOURNAMENTS.SIGNALS ? TOURNAMENTS.CLASSIC : stored;
		}

		// Fetch current round
		try {
			currentRound = await getCurrentRound(selectedTournament);
			endRound = currentRound - 1; // Latest resolved round
			startRound = Math.max(1, endRound - 99); // Last 100 rounds
			selectedRoundForTop10 = endRound;
		} catch (error) {
			console.error('Error fetching current round:', error);
			// Fallback values
			currentRound = 900;
			endRound = 899;
			startRound = 800;
			selectedRoundForTop10 = endRound;
		}

		// Load from URL params
		await loadFromUrlParams();
	});

	// Reactive user search with debouncing
	let searchTimeout: number;
	$effect(() => {
		clearTimeout(searchTimeout);

		if (userSearchQuery.length >= 2) {
			searchTimeout = setTimeout(() => {
				searchUsers();
			}, 300);
		} else {
			userSearchResults = [];
		}
	});

	// Reactive model search
	let modelSearchTimeout: number;
	$effect(() => {
		clearTimeout(modelSearchTimeout);

		if (!selectedUser && modelSearchQuery.trim().length >= 2) {
			modelSearchTimeout = setTimeout(() => {
				searchModelsByName();
			}, 300);
		} else if (!selectedUser) {
			modelSearchResults = [];
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
		if (!user || !user.username) return;

		selectedUser = user;
		userSearchQuery = user.username;
		modelSearchQuery = '';
		availableModels = [];
		modelLoadError = null;

		modelSearchLoading = true;
		try {
			const models = await numeraiApi.getUserModels(user.username, selectedTournament);
			availableModels = models
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			if (models.length === 0) {
				modelLoadError = `No ${TOURNAMENT_INFO[selectedTournament].name} models found for user "${user.username}"`;
			}
		} catch (error) {
			console.error('Error loading user models:', error);
			modelLoadError = `Failed to load models: ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			modelSearchLoading = false;
		}

		updateUrlParams();
	}

	function addModel(model: NumeraiModel) {
		if (!selectedModels.find(m => m.id === model.id)) {
			selectedModels = [...selectedModels, model];
			modelSearchQuery = '';
			modelSearchResults = [];
			updateUrlParams();
		}
	}

	function removeModel(modelId: string) {
		selectedModels = selectedModels.filter(m => m.id !== modelId);
		updateUrlParams();
	}

	async function loadRankings() {
		if (selectedModels.length === 0) return;

		loadingRankings = true;
		rankingsError = null;
		loadingProgress = { stage: 'Initializing', loaded: 0, total: 0 };

		try {
			// Calculate rankings for selected models
			rankingHistories = await calculateModelRankings(
				selectedModels.map(m => m.name),
				startRound,
				endRound,
				scoreFormula,
				selectedTournament,
				(stage, loaded, total) => {
					loadingProgress = { stage, loaded, total };
				}
			);

			// Load top 10 for the selected round
			await loadTop10ForRound(selectedRoundForTop10);

			if (rankingHistories.length === 0) {
				rankingsError = 'No ranking data was retrieved. The models may not have performance data in the selected round range.';
			}
		} catch (error) {
			console.error('Error loading rankings:', error);
			rankingsError = `Failed to load rankings: ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			loadingRankings = false;
		}
	}

	async function loadTop10ForRound(round: number) {
		try {
			topModels = await getTopModelsForRound(round, scoreFormula, selectedTournament, 10);
		} catch (error) {
			console.error('Error loading top 10:', error);
			topModels = [];
		}
	}

	function switchTournament(tournament: TournamentId) {
		// Only allow Classic or Crypto
		if (tournament === TOURNAMENTS.SIGNALS) return;
		if (tournament === selectedTournament) return;

		selectedTournament = tournament;
		setSelectedTournament(tournament);

		// Clear selections
		selectedModels = [];
		rankingHistories = [];
		topModels = [];
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		availableModels = [];
		modelSearchQuery = '';
		modelSearchResults = [];

		// Refetch current round for new tournament
		getCurrentRound(tournament).then(round => {
			currentRound = round;
			endRound = round - 1;
			startRound = Math.max(1, endRound - 99);
			selectedRoundForTop10 = endRound;
		}).catch(() => {});

		updateUrlParams();
	}

	function clearUserSelection() {
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		availableModels = [];
		modelLoadError = null;
		updateUrlParams();
	}

	function handleUserSearchInput(nextQuery: string) {
		if (!selectedUser || nextQuery === selectedUser.username) return;
		selectedUser = null;
		availableModels = [];
		modelSearchQuery = '';
		modelLoadError = null;
		updateUrlParams();
	}

	async function searchModelsByName() {
		if (!numeraiApi) return;

		const query = modelSearchQuery.trim();
		if (!query) {
			modelSearchResults = [];
			return;
		}

		modelSearchLoading = true;
		try {
			const models = await numeraiApi.getModelsByNames([query], selectedTournament);
			modelSearchResults = models
				.filter(m => m.tournament === selectedTournament)
				.filter(m => !selectedModels.find(s => s.id === m.id))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		} catch (error) {
			console.error('Error searching models:', error);
			modelSearchResults = [];
		}
		modelSearchLoading = false;
	}

	// Filter available models
	const filteredModels = $derived(
		selectedUser
			? availableModels
				.filter(model => model.name.toLowerCase().includes(modelSearchQuery.toLowerCase()))
				.filter(model => !selectedModels.find(m => m.id === model.id))
			: modelSearchResults
	);

	function getModelSearchPlaceholder(): string {
		const tournamentName = TOURNAMENT_INFO[selectedTournament].name;
		if (modelSearchLoading) return "Searching...";
		if (selectedUser && availableModels.length === 0) return `No ${tournamentName} models for this user`;
		if (selectedUser) return `Search user's ${tournamentName} models...`;
		return `Search ${tournamentName} models by name (2+ chars)...`;
	}

	// Preset round ranges
	function setRoundRange(rounds: number) {
		endRound = currentRound - 1;
		startRound = Math.max(1, endRound - rounds + 1);
	}

	function setLast50Rounds() { setRoundRange(50); }
	function setLast100Rounds() { setRoundRange(100); }
	function setLast200Rounds() { setRoundRange(200); }

	// Update score formula
	function updateFormula(field: keyof ScoreFormula, value: number) {
		scoreFormula = { ...scoreFormula, [field]: value };
	}

	function resetFormula() {
		scoreFormula = { ...DEFAULT_SCORE_FORMULA };
	}

	// URL parameter management
	function updateUrlParams() {
		if (!browser) return;

		const url = new URL(window.location.href);
		url.searchParams.set('tournament', selectedTournament.toString());

		if (selectedUser?.username) {
			url.searchParams.set('user', selectedUser.username);
		} else {
			url.searchParams.delete('user');
		}

		if (selectedModels.length > 0) {
			url.searchParams.set('models', selectedModels.map(m => m.name).join(','));
		} else {
			url.searchParams.delete('models');
		}

		url.searchParams.set('startRound', startRound.toString());
		url.searchParams.set('endRound', endRound.toString());

		replaceState(url.toString(), {});
	}

	async function loadFromUrlParams() {
		if (!browser) return;

		const url = new URL(window.location.href);
		const userParam = url.searchParams.get('user');
		const modelsParam = url.searchParams.get('models');
		const startParam = url.searchParams.get('startRound');
		const endParam = url.searchParams.get('endRound');

		if (startParam) startRound = parseInt(startParam, 10) || startRound;
		if (endParam) endRound = parseInt(endParam, 10) || endRound;

		if (modelsParam) {
			const modelNames = modelsParam.split(',').map(n => n.trim());
			try {
				const models = await numeraiApi.getModelsByNames(modelNames, selectedTournament);
				selectedModels = models.filter(m => m.tournament === selectedTournament);
			} catch (error) {
				console.error('Error loading models from URL:', error);
			}
		}

		if (userParam && !selectedUser) {
			userSearchQuery = userParam;
			await searchUsers();
			const user = userSearchResults.find(u => u.username === userParam);
			if (user) await selectUser(user);
		}
	}

	// Handle round selection for top 10 table
	async function onSelectRoundForTop10() {
		if (selectedRoundForTop10 > 0) {
			await loadTop10ForRound(selectedRoundForTop10);
		}
	}
</script>

<svelte:head>
	<title>NMR Rankings - {TOURNAMENT_INFO[selectedTournament].name} | Numerai Model Reviewer</title>
</svelte:head>

<div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 {themeClass}">
	<div class="mb-8">
		<h1 class="text-3xl font-bold retro-text-accent uppercase tracking-wider">MODEL RANKINGS</h1>
		<p class="mt-2 retro-text-secondary">Track model rank performance over time using custom scoring</p>
	</div>

	<!-- Tournament Tabs (Classic and Crypto only) -->
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

	<!-- Model Selection -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Select Models to Track</h2>

		<div class="grid gap-4 md:grid-cols-2">
			<!-- User Search -->
			<div>
				<div class="flex items-center justify-between">
					<label for="userSearch" class="block text-sm font-medium retro-text-primary">Search Users</label>
					{#if userSearchLoading}
						<span class="text-xs retro-text-accent">Searching...</span>
					{/if}
				</div>
				<div class="relative mt-1">
					<Autocomplete
						id="userSearch"
						bind:value={userSearchQuery}
						options={userSearchResults.map(user => ({
							id: user.id,
							label: user.username,
							value: user
						}))}
						placeholder="Type username to search (2+ chars)..."
						loading={userSearchLoading}
						selectOnClick={Boolean(selectedUser)}
						oninputvalue={handleUserSearchInput}
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
			</div>

			<!-- Model Search -->
			<div>
				<div class="flex items-center justify-between">
					<label for="modelSearch" class="block text-sm font-medium retro-text-primary">Search Models</label>
					{#if modelSearchLoading}
						<span class="text-xs retro-text-accent">Searching...</span>
					{:else if selectedUser && availableModels.length > 0}
						<span class="text-xs retro-text-success">{availableModels.length} models</span>
					{/if}
				</div>

				{#if modelLoadError}
					<div class="mt-1 rounded-md bg-[var(--retro-error)]/20 border border-[var(--retro-error)] p-2">
						<span class="text-sm retro-text-error">{modelLoadError}</span>
					</div>
				{:else}
					<Autocomplete
						id="modelSearch"
						bind:value={modelSearchQuery}
						options={filteredModels.map(model => ({
							id: model.id,
							label: `${model.name} (${model.username})`,
							value: model
						}))}
						placeholder={getModelSearchPlaceholder()}
						loading={modelSearchLoading}
						onselect={addModel}
						class="mt-1"
					/>
				{/if}
			</div>
		</div>

		<!-- Selected Models -->
		{#if selectedModels.length > 0}
			<div class="mt-4">
				<h3 class="text-sm font-medium retro-text-primary">Selected Models</h3>
				<div class="mt-2 flex flex-wrap gap-2">
					{#each selectedModels as model}
						<span class="inline-flex items-center rounded-full bg-[var(--retro-primary)]/30 border border-[var(--retro-primary)] px-3 py-1 text-sm retro-text-primary">
							{model.name} ({model.username})
							<button
								onclick={() => removeModel(model.id)}
								class="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full retro-text-secondary hover:retro-bg-accent hover:text-white"
							>
								x
							</button>
						</span>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<!-- Score Formula Configuration -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-medium retro-text-primary uppercase">Score Formula</h2>
			<button
				onclick={resetFormula}
				class="text-sm retro-text-accent hover:underline"
			>
				Reset to Default
			</button>
		</div>

		<p class="text-sm retro-text-secondary mb-4">
			Custom Score = (Corr Weight × Corr) + (MMC Weight × MMC) + (TC Weight × TC)
		</p>

		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="corrWeight" class="block text-sm font-medium retro-text-primary">Corr Weight</label>
				<input
					id="corrWeight"
					type="number"
					step="0.25"
					value={scoreFormula.corrWeight}
					onchange={(e) => updateFormula('corrWeight', parseFloat(e.currentTarget.value) || 0)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="mmcWeight" class="block text-sm font-medium retro-text-primary">MMC Weight</label>
				<input
					id="mmcWeight"
					type="number"
					step="0.25"
					value={scoreFormula.mmcWeight}
					onchange={(e) => updateFormula('mmcWeight', parseFloat(e.currentTarget.value) || 0)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="tcWeight" class="block text-sm font-medium retro-text-primary">TC Weight</label>
				<input
					id="tcWeight"
					type="number"
					step="0.25"
					value={scoreFormula.tcWeight}
					onchange={(e) => updateFormula('tcWeight', parseFloat(e.currentTarget.value) || 0)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
		</div>

		<p class="mt-2 text-xs retro-text-secondary">
			Default: {DEFAULT_SCORE_FORMULA.corrWeight}×Corr + {DEFAULT_SCORE_FORMULA.mmcWeight}×MMC + {DEFAULT_SCORE_FORMULA.tcWeight}×TC
		</p>
	</div>

	<!-- Round Range Configuration -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Round Range</h2>

		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="startRound" class="block text-sm font-medium retro-text-primary">Start Round</label>
				<input
					id="startRound"
					type="number"
					bind:value={startRound}
					min="1"
					max={endRound}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="endRound" class="block text-sm font-medium retro-text-primary">End Round</label>
				<input
					id="endRound"
					type="number"
					bind:value={endRound}
					min={startRound}
					max={currentRound - 1}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div class="flex items-end">
				<span class="text-sm retro-text-secondary">
					Current Round: {currentRound}
				</span>
			</div>
		</div>

		<div class="mt-4 flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium retro-text-primary">Quick Range:</span>
			<button
				onclick={setLast50Rounds}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-primary)] transition-colors"
			>
				Last 50
			</button>
			<button
				onclick={setLast100Rounds}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-primary)] transition-colors"
			>
				Last 100
			</button>
			<button
				onclick={setLast200Rounds}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-primary)] transition-colors"
			>
				Last 200
			</button>
		</div>

		<div class="mt-4">
			<button
				onclick={loadRankings}
				disabled={selectedModels.length === 0 || loadingRankings}
				class="retro-button rounded-md px-6 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
			>
				{loadingRankings ? 'Loading...' : 'Calculate Rankings'}
			</button>
		</div>

		<!-- Loading Progress -->
		{#if loadingRankings}
			<div class="mt-4 p-4 rounded-lg retro-bg-secondary">
				<div class="flex items-center justify-between mb-2">
					<span class="text-sm retro-text-primary">{loadingProgress.stage}</span>
					<span class="text-sm retro-text-accent">
						{loadingProgress.loaded} / {loadingProgress.total}
					</span>
				</div>
				<div class="w-full bg-[var(--retro-light-grey)] rounded-full h-2">
					<div
						class="bg-[var(--retro-primary)] h-2 rounded-full transition-all duration-300"
						style="width: {loadingProgress.total > 0 ? (loadingProgress.loaded / loadingProgress.total) * 100 : 0}%"
					></div>
				</div>
			</div>
		{/if}

		<!-- Rankings Error -->
		{#if rankingsError}
			<div class="mt-4 rounded-md bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] p-4">
				<p class="text-sm retro-text-warning">{rankingsError}</p>
			</div>
		{/if}
	</div>

	<!-- Rankings Chart -->
	{#if rankingHistories.length > 0}
		<div class="mb-6 rounded-lg retro-card p-6">
			<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Ranking History</h2>
			<RankingsChart
				{rankingHistories}
				{startRound}
				{endRound}
			/>
		</div>
	{/if}

	<!-- Top 10 Table -->
	{#if rankingHistories.length > 0 || topModels.length > 0}
		<div class="rounded-lg retro-card">
			<div class="px-6 py-4 border-b retro-border-secondary border-2">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-medium retro-text-primary uppercase">Top 10 Staked Models</h2>
					<div class="flex items-center gap-2">
						<label for="roundSelect" class="text-sm retro-text-secondary">Round:</label>
						<input
							id="roundSelect"
							type="number"
							bind:value={selectedRoundForTop10}
							min="1"
							max={currentRound - 1}
							onchange={onSelectRoundForTop10}
							class="retro-input w-24 rounded-md px-2 py-1 text-sm"
						/>
					</div>
				</div>
				<p class="text-sm retro-text-secondary mt-1">
					Top performing staked models for Round {selectedRoundForTop10} using current score formula
				</p>
			</div>

			<div class="overflow-x-auto">
				<table class="min-w-full divide-y retro-border-secondary border-2">
					<thead class="retro-bg-secondary">
						<tr>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Rank</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Model</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">User</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Corr</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">MMC</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">TC</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Custom Score</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
						{#each topModels as model, index}
							<tr class="{selectedModels.find(m => m.name.toLowerCase() === model.modelName.toLowerCase()) ? 'bg-[var(--retro-primary)]/20' : ''}">
								<td class="whitespace-nowrap px-4 py-3 text-sm font-bold retro-text-accent">
									#{model.rank ?? index + 1}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm font-medium retro-text-primary">
									{model.modelName}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm retro-text-secondary">
									{model.username}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.corr !== null}
										<span class="{model.corr > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{model.corr.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.mmc !== null}
										<span class="{model.mmc > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{model.mmc.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm">
									{#if model.tc !== null}
										<span class="{model.tc > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{model.tc.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-4 py-3 text-sm font-bold">
									{#if model.customScore !== null}
										<span class="{model.customScore > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{model.customScore.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="7" class="px-4 py-8 text-center retro-text-secondary">
									Click "Calculate Rankings" to load top 10 models
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
