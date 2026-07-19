<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Autocomplete from '$lib/components/Autocomplete.svelte';
	import RankingsChart from '$lib/components/RankingsChart.svelte';
	import { NumeraiAPI } from '$lib/numerai-api.js';
	import { config } from '$lib/config.js';
	import {
		calculateModelRankings,
		getTopModelsForRound,
		getCurrentRound,
		getCacheStatus,
		DEFAULT_SCORE_FORMULA,
		getDefaultFormulaForTournament,
		latestRoundWithData,
		type UnrankedModel
	} from '$lib/rankings-api.js';
	import type { NumeraiUser, NumeraiModel, ModelRankingHistory, ScoreFormula, RoundModelScore } from '$lib/types.js';
	import {
		getSelectedTournament,
		setSelectedTournament,
		getRankingDisplayMode,
		setRankingDisplayMode,
		TOURNAMENTS,
		TOURNAMENT_INFO,
		type TournamentId
	} from '$lib/utils/storage.js';
	import {
		formatPercentile,
		rankToPercentile,
		type RankingDisplayMode
	} from '$lib/utils/ranking-display.js';
	import { paginateModels } from '$lib/utils/paginate-models.js';
	import { formatModelOption } from '$lib/utils/format-model-option.js';
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

	// Models that "Calculate Rankings" will rank: the explicitly selected ones,
	// or — when none are picked — every model of the selected user. Lets a user
	// chart a whole account in one click without selecting each model.
	const modelsToRank = $derived(
		selectedModels.length > 0 ? selectedModels : selectedUser ? availableModels : []
	);
	// True when the fallback (all of the user's models) is in effect.
	const usingAllUserModels = $derived(selectedModels.length === 0 && modelsToRank.length > 0);

	// Tournament selection (Classic and Crypto only)
	let selectedTournament = $state<TournamentId>(TOURNAMENTS.CLASSIC);
	const themeClass = $derived(TOURNAMENT_INFO[selectedTournament].theme);

	// Metric labels are tournament-specific. Classic/Crypto score on corr+mmc;
	// Signals scores on alpha+mpc (the worker returns alpha/mpc in the corr/mmc
	// fields for tournament 11). The corrWeight/mmcWeight inputs drive both.
	const isSignals = $derived(selectedTournament === TOURNAMENTS.SIGNALS);
	const metric1Label = $derived(isSignals ? 'Alpha' : 'Corr');
	const metric2Label = $derived(isSignals ? 'MPC' : 'MMC');
	const scoreFormulaDefault = $derived(getDefaultFormulaForTournament(selectedTournament));

	// Round range
	let currentRound = $state(0);
	let startRound = $state(0);
	let endRound = $state(0);

	// Latest round the precomputed cache holds for this tournament (lags the live
	// current round until the next precompute run). null = unknown / endpoint
	// unavailable. Surfaced so users know which rounds actually have data.
	let cacheLatestRound = $state<number | null>(null);
	let cacheEarliestRound = $state<number | null>(null);

	async function loadCacheStatus() {
		const status = await getCacheStatus(selectedTournament);
		cacheLatestRound = status?.latestRound ?? null;
		cacheEarliestRound = status?.earliestRound ?? null;
	}

	// Default round range: end at the last cached round (later rounds have no data
	// yet), start 30 rounds earlier. Falls back to currentRound-1 when the cache
	// coverage is unknown. Applies to all tournaments.
	const DEFAULT_RANGE_ROUNDS = 30;
	// Highest selectable round: the last cached round (data past it is empty),
	// falling back to currentRound-1 when cache coverage is unknown.
	const maxRound = $derived(cacheLatestRound ?? Math.max(1, currentRound - 1));

	function applyDefaultRange() {
		const end = maxRound;
		endRound = end;
		startRound = Math.max(1, end - DEFAULT_RANGE_ROUNDS);
		selectedRoundForTop10 = end;
	}

	// endRound never exceeds the latest cached round; keep startRound <= endRound.
	function clampRange() {
		if (endRound > maxRound) endRound = maxRound;
		if (endRound < 1) endRound = 1;
		if (startRound < 1) startRound = 1;
		if (startRound > endRound) startRound = endRound;
		if (selectedRoundForTop10 > maxRound) selectedRoundForTop10 = maxRound;
	}

	// Score formula
	let scoreFormula = $state<ScoreFormula>({ ...DEFAULT_SCORE_FORMULA });

	// How ranks are displayed: 'rank' (1 = best, lower better) or 'percentile'
	// (higher better). Derived client-side from rank + totalModels; persisted.
	let rankingDisplayMode = $state<RankingDisplayMode>('rank');

	function setDisplayMode(mode: RankingDisplayMode) {
		rankingDisplayMode = mode;
		setRankingDisplayMode(mode);
	}

	// Rolling window for rank computation: 1 = per-round, 20/60 = trailing
	// MMC20/CORR60-style averages (matches Numerai's leaderboard). The worker ranks
	// the field on the windowed metric, so changing this re-fetches.
	let rollingWindow = $state(1);
	const ROLLING_WINDOWS: Array<{ label: string; value: number }> = [
		{ label: 'Per round', value: 1 },
		{ label: '20-round avg', value: 20 },
		{ label: '60-round avg', value: 60 }
	];

	async function setRollingWindow(value: number) {
		if (value === rollingWindow) return;
		rollingWindow = value;
		updateUrlParams();
		// Re-rank with the new window if a chart is already loaded (or a user/models
		// are selected so loadRankings has something to compute).
		if (rankingHistories.length > 0 || modelsToRank.length > 0) {
			await loadRankings();
		}
	}

	// Rankings data
	let rankingHistories = $state<ModelRankingHistory[]>([]);
	let topModels = $state<RoundModelScore[]>([]);
	let loadingRankings = $state(false);
	let rankingsError = $state<string | null>(null);
	// Selected models that couldn't be ranked, with the reason (not staked for
	// the range, or no cached data). Surfaced so they aren't silently dropped.
	let unrankedModels = $state<UnrankedModel[]>([]);
	let loadingProgress = $state({ stage: '', loaded: 0, total: 0 });

	// Per-round staked-model table. `topModels` now holds the FULL ranked field
	// for the round; the table searches + paginates it client-side so users can
	// find their own model, not just the top N.
	let selectedRoundForTop10 = $state(0);
	let modelTableQuery = $state('');
	let modelTablePage = $state(1);
	const MODEL_TABLE_PAGE_SIZE = 25;
	const pagedTopModels = $derived(
		paginateModels(topModels, modelTableQuery, modelTablePage, MODEL_TABLE_PAGE_SIZE)
	);

	onMount(async () => {
		numeraiApi = new NumeraiAPI();

		// Load tournament from URL or localStorage. Signals is now supported on
		// rankings (uses alpha+mpc scoring server-side); Crypto and Classic use
		// corr+mmc. The frontend treats all three uniformly.
		const url = new URL(window.location.href);
		const tournamentParam = url.searchParams.get('tournament');
		if (tournamentParam) {
			const parsedTournament = parseInt(tournamentParam, 10) as TournamentId;
			if (
				parsedTournament === TOURNAMENTS.CLASSIC ||
				parsedTournament === TOURNAMENTS.SIGNALS ||
				parsedTournament === TOURNAMENTS.CRYPTO
			) {
				selectedTournament = parsedTournament;
				setSelectedTournament(parsedTournament);
			}
		} else {
			selectedTournament = getSelectedTournament();
		}

		// Seed the formula with the tournament-appropriate defaults.
		scoreFormula = getDefaultFormulaForTournament(selectedTournament);

		// Restore the persisted rankings display mode.
		rankingDisplayMode = getRankingDisplayMode();

		// Fetch current round (used as a fallback when the cache coverage is unknown).
		try {
			currentRound = await getCurrentRound(selectedTournament);
		} catch (error) {
			console.error('Error fetching current round:', error);
			currentRound = 900; // Fallback
		}

		// Surface the cache's round coverage (non-blocking; safe if unavailable).
		await loadCacheStatus();

		// Default the range to the cache window: end at the last cached round (data
		// past it is empty), start 30 rounds earlier. Falls back to currentRound-1
		// when cache coverage is unknown.
		applyDefaultRange();

		// Load from URL params (explicit start/end override the defaults above).
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
		// Rank the explicitly selected models, or fall back to all of the selected
		// user's models when none are picked.
		const models = modelsToRank;
		if (models.length === 0) return;

		loadingRankings = true;
		rankingsError = null;
		loadingProgress = { stage: 'Initializing', loaded: 0, total: 0 };

		unrankedModels = [];
		try {
			// Calculate rankings for the resolved models
			const result = await calculateModelRankings(
				models.map(m => ({ modelName: m.name, modelId: m.id, username: m.username })),
				startRound,
				endRound,
				scoreFormula,
				selectedTournament,
				(stage, loaded, total) => {
					loadingProgress = { stage, loaded, total };
				},
				rollingWindow
			);
			rankingHistories = result.histories;
			unrankedModels = result.unranked;

			// Default the table to the latest round that actually has a staked
			// field — the end of the range is often unresolved (empty), which would
			// otherwise show "Top 0 Staked Models".
			const bestRound = latestRoundWithData(rankingHistories);
			if (bestRound !== null) {
				selectedRoundForTop10 = bestRound;
			}
			await loadTopModelsForRound(selectedRoundForTop10);

			if (rankingHistories.length === 0) {
				// Refresh coverage in case the cache advanced since page load, then
				// point the user at the rounds that actually have data.
				await loadCacheStatus();
				let msg =
					'No ranking data was retrieved. The selected models may not be in the staked field for this round range.';
				if (cacheLatestRound !== null) {
					msg += ` The cache currently has data for rounds ${cacheEarliestRound ?? 1}–${cacheLatestRound} (it lags the live round ${currentRound}). Try a range ending at or before round ${cacheLatestRound}.`;
				}
				rankingsError = msg;
			}
		} catch (error) {
			console.error('Error loading rankings:', error);
			rankingsError = `Failed to load rankings: ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			loadingRankings = false;
		}
	}

	async function loadTopModelsForRound(round: number) {
		// limit=0 → the worker returns the whole ranked field; we page it locally.
		try {
			topModels = await getTopModelsForRound(round, scoreFormula, selectedTournament, 0, rollingWindow);
		} catch (error) {
			console.error('Error loading staked models:', error);
			topModels = [];
		}
		modelTablePage = 1;
	}

	function switchTournament(tournament: TournamentId) {
		if (tournament === selectedTournament) return;

		selectedTournament = tournament;
		setSelectedTournament(tournament);

		// Reset to tournament-appropriate scoring defaults.
		scoreFormula = getDefaultFormulaForTournament(tournament);

		// Clear selections
		selectedModels = [];
		rankingHistories = [];
		unrankedModels = [];
		topModels = [];
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		availableModels = [];
		modelSearchQuery = '';
		modelSearchResults = [];

		// Refetch current round + cache coverage, then default the range to the new
		// tournament's cache window (end = last cached round, start 30 earlier).
		getCurrentRound(tournament)
			.then((round) => (currentRound = round))
			.catch(() => {});
		loadCacheStatus().then(() => {
			applyDefaultRange();
			updateUrlParams();
		});

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

	// Preset round ranges. `rounds: null` means "all available history"
	// (back to round 1) — useful now that precompute caches the full window.
	const RANGE_PRESETS: Array<{ label: string; rounds: number | null }> = [
		{ label: 'Last 50', rounds: 50 },
		{ label: 'Last 100', rounds: 100 },
		{ label: 'Last 200', rounds: 200 },
		{ label: 'Last 500', rounds: 500 },
		{ label: 'All', rounds: null }
	];

	function setRoundRange(rounds: number | null) {
		endRound = maxRound;
		startRound = rounds === null ? 1 : Math.max(1, endRound - rounds + 1);
		clampRange();
	}

	// Update score formula
	function updateFormula(field: keyof ScoreFormula, value: number) {
		scoreFormula = { ...scoreFormula, [field]: value };
	}

	function resetFormula() {
		scoreFormula = getDefaultFormulaForTournament(selectedTournament);
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

		if (rollingWindow > 1) {
			url.searchParams.set('window', rollingWindow.toString());
		} else {
			url.searchParams.delete('window');
		}

		replaceState(url.toString(), {});
	}

	async function loadFromUrlParams() {
		if (!browser) return;

		const url = new URL(window.location.href);
		const userParam = url.searchParams.get('user');
		const modelsParam = url.searchParams.get('models');
		const startParam = url.searchParams.get('startRound');
		const endParam = url.searchParams.get('endRound');
		const windowParam = url.searchParams.get('window');

		if (startParam) startRound = parseInt(startParam, 10) || startRound;
		if (endParam) endRound = parseInt(endParam, 10) || endRound;
		if (windowParam) rollingWindow = Math.max(1, parseInt(windowParam, 10) || 1);
		// endRound from a URL can point past the cache (empty tail) — clamp it.
		clampRange();

		if (modelsParam) {
			const modelNames = modelsParam.split(',').map(n => n.trim());
			try {
				// Pass the URL's user as the owner hint so Crypto resolves via a
				// single getUserModels call instead of a leaderboard scan.
				const models = await numeraiApi.getModelsByNames(
					modelNames,
					selectedTournament,
					userParam ?? undefined
				);
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

		// Auto-render: if the URL pre-selected models — or just a user, in which
		// case we fall back to all of their models — run the calculation so the
		// chart appears without a manual "Calculate Rankings" click.
		if (modelsToRank.length > 0 && startRound > 0 && endRound >= startRound) {
			await loadRankings();
		}
	}

	// Handle round selection for the staked-models table
	async function onSelectRoundForTop10() {
		if (selectedRoundForTop10 > 0) {
			await loadTopModelsForRound(selectedRoundForTop10);
		}
	}

	// Clicking a point in the ranking history jumps the table to that round and
	// pages/scrolls so the clicked model sits in the middle of the view.
	async function handleChartPointSelect(round: number, modelName: string) {
		if (round <= 0) return;
		selectedRoundForTop10 = round;
		modelTableQuery = ''; // clear any filter so the model is in the full list
		await loadTopModelsForRound(round);

		const idx = topModels.findIndex(
			(m) => m.modelName.toLowerCase() === modelName.toLowerCase()
		);
		if (idx < 0) return;

		modelTablePage = Math.floor(idx / MODEL_TABLE_PAGE_SIZE) + 1;
		await tick();
		const rank = topModels[idx].rank;
		document
			.getElementById(`staked-row-${rank}`)
			?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
</script>

<svelte:head>
	<title>NMR Rankings - {TOURNAMENT_INFO[selectedTournament].name} | Numerai Model Reviewer</title>
</svelte:head>

<div class="mx-auto max-w-7xl px-2 py-6 sm:px-6 sm:py-8 lg:px-8 {themeClass}">
	<div class="mb-8">
		<h1 class="text-3xl font-bold retro-text-accent uppercase tracking-wider">MODEL RANKINGS</h1>
		<p class="mt-2 retro-text-secondary">Track model rank performance over time using custom scoring</p>
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

	<!-- Model Selection -->
	<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
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
							label: formatModelOption(model),
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
		{:else if selectedUser && availableModels.length > 0}
			<div class="mt-4 rounded-md bg-[var(--retro-primary)]/10 border border-[var(--retro-primary)] p-3">
				<p class="text-sm retro-text-primary">
					<span class="font-medium">Tip:</span> no models selected — all {availableModels.length}
					of {selectedUser.username}'s models will be ranked. Pick specific models above to focus on just those.
				</p>
			</div>
		{/if}
	</div>

	<!-- Score Formula Configuration -->
	<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
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
			Custom Score = ({metric1Label} Weight × {metric1Label}) + ({metric2Label} Weight × {metric2Label})
		</p>

		<div class="grid gap-4 md:grid-cols-2">
			<div>
				<label for="corrWeight" class="block text-sm font-medium retro-text-primary">{metric1Label} Weight</label>
				<input
					id="corrWeight"
					type="number"
					step="0.05"
					value={scoreFormula.corrWeight}
					onchange={(e) => updateFormula('corrWeight', parseFloat(e.currentTarget.value) || 0)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="mmcWeight" class="block text-sm font-medium retro-text-primary">{metric2Label} Weight</label>
				<input
					id="mmcWeight"
					type="number"
					step="0.05"
					value={scoreFormula.mmcWeight}
					onchange={(e) => updateFormula('mmcWeight', parseFloat(e.currentTarget.value) || 0)}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
		</div>

		<p class="mt-2 text-xs retro-text-secondary">
			Default: {scoreFormulaDefault.corrWeight}×{metric1Label} + {scoreFormulaDefault.mmcWeight}×{metric2Label}
		</p>
	</div>

	<!-- Ranking Display Mode -->
	<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
		<div class="flex flex-wrap items-center gap-4">
			<span class="text-sm font-medium retro-text-primary uppercase">Display:</span>
			<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
				<button
					onclick={() => setDisplayMode('rank')}
					class="px-3 py-1 text-sm font-medium transition-colors"
					style={rankingDisplayMode === 'rank'
						? 'background-color: var(--retro-primary); color: white;'
						: 'color: var(--retro-text-primary);'}
				>
					Rank (lower is better)
				</button>
				<button
					onclick={() => setDisplayMode('percentile')}
					class="px-3 py-1 text-sm font-medium transition-colors"
					style={rankingDisplayMode === 'percentile'
						? 'background-color: var(--retro-primary); color: white;'
						: 'color: var(--retro-text-primary);'}
				>
					Percentile (higher is better)
				</button>
			</div>
		</div>
		<p class="mt-2 text-xs retro-text-secondary">
			Percentile = (totalModels − rank + 1) / totalModels × 100, per round (best ≈ 100).
		</p>
	</div>

	<!-- Rolling Average Window -->
	<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
		<div class="flex flex-wrap items-center gap-4">
			<span class="text-sm font-medium retro-text-primary uppercase">Rolling Average:</span>
			<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
				{#each ROLLING_WINDOWS as win (win.value)}
					<button
						onclick={() => setRollingWindow(win.value)}
						class="px-3 py-1 text-sm font-medium transition-colors"
						style={rollingWindow === win.value
							? 'background-color: var(--retro-primary); color: white;'
							: 'color: var(--retro-text-primary);'}
					>
						{win.label}
					</button>
				{/each}
			</div>
		</div>
		<p class="mt-2 text-xs retro-text-secondary">
			Ranks each round on the trailing N-round average of the {metric1Label}/{metric2Label} score,
			like Numerai's {metric2Label}20 / {metric1Label}60 leaderboard columns. "Per round" uses each round's own score.
		</p>
	</div>

	<!-- Round Range Configuration -->
	<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
		<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Round Range</h2>

		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="startRound" class="block text-sm font-medium retro-text-primary">Start Round</label>
				<input
					id="startRound"
					type="number"
					bind:value={startRound}
					onchange={clampRange}
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
					onchange={clampRange}
					min={startRound}
					max={maxRound}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm"
				/>
			</div>
			<div class="flex flex-col justify-end">
				<span class="text-sm retro-text-secondary">
					Current Round: {currentRound}
				</span>
				{#if cacheLatestRound !== null}
					<span class="text-xs retro-text-secondary">
						Cache data: rounds {cacheEarliestRound ?? 1}–{cacheLatestRound}
					</span>
				{/if}
			</div>
		</div>

		<div class="mt-4 flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium retro-text-primary">Quick Range:</span>
			{#each RANGE_PRESETS as preset (preset.label)}
				<button
					onclick={() => setRoundRange(preset.rounds)}
					class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-primary)] transition-colors"
				>
					{preset.label}
				</button>
			{/each}
		</div>

		<div class="mt-4">
			<button
				onclick={loadRankings}
				disabled={modelsToRank.length === 0 || loadingRankings}
				class="retro-button rounded-md px-6 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
			>
				{loadingRankings
					? 'Loading...'
					: usingAllUserModels
						? `Calculate Rankings (all ${modelsToRank.length} of ${selectedUser?.username ?? 'user'}'s models)`
						: 'Calculate Rankings'}
			</button>
			{#if usingAllUserModels}
				<p class="mt-2 text-xs retro-text-secondary">
					No models selected — ranking all {modelsToRank.length} of {selectedUser?.username}'s models. Add models above to narrow this down.
				</p>
			{/if}
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

		<!-- Unranked models (not staked for the range, or no cached data) -->
		{#if unrankedModels.length > 0}
			<div class="mt-4 rounded-md bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] p-4">
				<p class="text-sm font-medium retro-text-warning mb-1">
					{unrankedModels.length} model{unrankedModels.length === 1 ? '' : 's'} could not be ranked for rounds {startRound}–{endRound}:
				</p>
				<ul class="list-disc pl-5 text-sm retro-text-warning">
					{#each unrankedModels as m (m.modelName)}
						<li>
							<span class="font-medium">{m.modelName}</span>
							{#if m.reason === 'unstaked'}
								— not staked in this round range (no ranking).
							{:else}
								— no cached data for this range{cacheLatestRound !== null ? ` (cache covers rounds ${cacheEarliestRound ?? 1}–${cacheLatestRound})` : ''}.
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>

	<!-- Rankings Chart -->
	{#if rankingHistories.length > 0}
		<div class="mb-6 rounded-lg retro-card p-3 sm:p-6">
			<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Ranking History</h2>
			<p class="mb-2 text-xs retro-text-secondary">Click a point to jump the table below to that round and model.</p>
			<RankingsChart
				{rankingHistories}
				{startRound}
				{endRound}
				displayMode={rankingDisplayMode}
				{metric1Label}
				{metric2Label}
				rollingWindow={rollingWindow}
				onPointSelect={handleChartPointSelect}
			/>
		</div>
	{/if}

	<!-- Top 10 Table -->
	{#if rankingHistories.length > 0 || topModels.length > 0}
		<div class="rounded-lg retro-card">
			<div class="px-6 py-4 border-b retro-border-secondary border-2">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-medium retro-text-primary uppercase">
						Top {topModels.length} Staked Models
					</h2>
					<div class="flex items-center gap-2">
						<label for="roundSelect" class="text-sm retro-text-secondary">Round:</label>
						<input
							id="roundSelect"
							type="number"
							bind:value={selectedRoundForTop10}
							min="1"
							max={maxRound}
							onchange={onSelectRoundForTop10}
							class="retro-input w-24 rounded-md px-2 py-1 text-sm"
						/>
					</div>
				</div>
				<p class="text-sm retro-text-secondary mt-1">
					Staked models for Round {selectedRoundForTop10} ranked by the current score formula
				</p>
				<div class="mt-3 flex items-center gap-2">
					<label for="modelTableSearch" class="sr-only">Search models</label>
					<input
						id="modelTableSearch"
						type="text"
						bind:value={modelTableQuery}
						oninput={() => (modelTablePage = 1)}
						placeholder="Search this round's models by name..."
						class="retro-input w-full max-w-xs rounded-md px-3 py-1.5 text-sm"
					/>
					{#if modelTableQuery.trim()}
						<span class="text-sm retro-text-secondary whitespace-nowrap">
							{pagedTopModels.totalFiltered} match{pagedTopModels.totalFiltered === 1 ? '' : 'es'}
						</span>
						<button
							onclick={() => { modelTableQuery = ''; modelTablePage = 1; }}
							class="text-sm retro-text-accent hover:underline"
						>
							Clear
						</button>
					{/if}
				</div>
			</div>

			<div class="overflow-x-auto">
				<table class="min-w-full divide-y retro-border-secondary border-2">
					<thead class="retro-bg-secondary">
						<tr>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">{rankingDisplayMode === 'percentile' ? 'Percentile' : 'Rank'}</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Model</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">User</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">{metric1Label}</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">{metric2Label}</th>
							<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Custom Score</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
						{#each pagedTopModels.items as model, index}
							<tr id="staked-row-{model.rank}" class="{selectedModels.find(m => m.name.toLowerCase() === model.modelName.toLowerCase()) ? 'bg-[var(--retro-primary)]/20' : ''}">
								<td class="whitespace-nowrap px-4 py-3 text-sm font-bold {rankingDisplayMode === 'percentile' ? 'retro-text-primary' : 'retro-text-accent'}">
									{#if rankingDisplayMode === 'percentile'}
										{@const pct = rankToPercentile(model.rank ?? index + 1, model.totalModels)}
										{pct !== null ? formatPercentile(pct) : 'N/A'}
									{:else}
										#{model.rank ?? index + 1}
									{/if}
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
								<td colspan="6" class="px-4 py-8 text-center retro-text-secondary">
									{#if topModels.length > 0}
										No models match "{modelTableQuery.trim()}" in Round {selectedRoundForTop10}
									{:else}
										Click "Calculate Rankings" to load this round's staked models
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if pagedTopModels.totalFiltered > MODEL_TABLE_PAGE_SIZE}
				<div class="flex items-center justify-between px-6 py-3 border-t retro-border-secondary border-2">
					<span class="text-sm retro-text-secondary">
						Showing {(pagedTopModels.page - 1) * MODEL_TABLE_PAGE_SIZE + 1}–{Math.min(
							pagedTopModels.page * MODEL_TABLE_PAGE_SIZE,
							pagedTopModels.totalFiltered
						)} of {pagedTopModels.totalFiltered}
					</span>
					<div class="flex items-center gap-2">
						<button
							onclick={() => (modelTablePage = pagedTopModels.page - 1)}
							disabled={pagedTopModels.page <= 1}
							class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:border-[var(--retro-primary)] disabled:cursor-not-allowed disabled:opacity-50"
						>
							Prev
						</button>
						<span class="text-sm retro-text-secondary">
							Page {pagedTopModels.page} of {pagedTopModels.totalPages}
						</span>
						<button
							onclick={() => (modelTablePage = pagedTopModels.page + 1)}
							disabled={pagedTopModels.page >= pagedTopModels.totalPages}
							class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:border-[var(--retro-primary)] disabled:cursor-not-allowed disabled:opacity-50"
						>
							Next
						</button>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
