<script lang="ts">
	import { onMount } from 'svelte';
	import Autocomplete from '$lib/components/Autocomplete.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import { NumeraiAPI } from '$lib/numerai-api.js';
	import type { NumeraiUser, NumeraiModel, ModelPerformance, SavedChart } from '$lib/types.js';
	import {
		saveChart,
		getSavedCharts,
		getRecentUserModels,
		addRecentUserModel,
		getRecentCharts,
		addRecentChart,
		type RecentUserModel,
		type RecentChart
	} from '$lib/utils/storage.js';
	import { updateUrlWithChart, generateShareableUrl, clearUrlParams } from '$lib/utils/url.js';
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
	let modelSearchResults = $state<NumeraiModel[]>([]); // API search results when no user selected

	// Selected models and data
	let selectedModels = $state<NumeraiModel[]>([]);
	let modelPerformance = $state<ModelPerformance[]>([]);
	let loadingPerformance = $state(false);
	let performanceError = $state<string | null>(null);

	// Date range
	let startDate = $state('');
	let endDate = $state('');


	// Chart management
	let savedCharts = $state<SavedChart[]>([]);
	let chartName = $state('');
	let shareableUrl = $state('');

	// Recent items
	let recentUserModels = $state<RecentUserModel[]>([]);
	let recentCharts = $state<RecentChart[]>([]);
	let showRecentDropdown = $state(false);

	onMount(async () => {
		// Initialize API (no credentials needed - handled server-side)
		numeraiApi = new NumeraiAPI();

		// Set default date range (last 30 days)
		const now = new Date();
		const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		startDate = thirtyDaysAgo.toISOString().split('T')[0];
		endDate = now.toISOString().split('T')[0];

		// Load saved charts and recent items
		savedCharts = getSavedCharts();
		recentUserModels = getRecentUserModels();
		recentCharts = getRecentCharts();

		// Check for URL parameters and load state
		await loadFromUrlParams();
	});

	// Reactive user search with debouncing
	let searchTimeout: number;
	$effect(() => {
		clearTimeout(searchTimeout);

		if (userSearchQuery.length >= 2) {
			searchTimeout = setTimeout(() => {
				searchUsers();
			}, 300); // 300ms debounce
		} else {
			userSearchResults = [];
		}
	});

	// Reactive model search with debouncing (API search when no user selected)
	let modelSearchTimeout: number;
	$effect(() => {
		clearTimeout(modelSearchTimeout);

		// Only do API search when no user is selected
		if (!selectedUser && modelSearchQuery.trim().length >= 2) {
			modelSearchTimeout = setTimeout(() => {
				searchModelsByName();
			}, 300);
		} else if (!selectedUser) {
			modelSearchResults = [];
		}
	});

	// Handle any pending model names when user changes
	$effect(() => {
		if (!browser || !selectedUser || availableModels.length === 0 || modelSearchLoading) return;

		// Check if we have pending model names to load when a user is selected
		const pendingModelNames = window.pendingModelNames;
		if (pendingModelNames && pendingModelNames.length > 0) {
			loadModelsFromNames(pendingModelNames);
			delete window.pendingModelNames;
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

		// Validate user object before proceeding
		if (!user || !user.username) {
			console.error('Invalid user object:', user);
			return;
		}

		// Reset model-related state but preserve selected models for cross-user comparison
		selectedUser = user;
		userSearchQuery = user.username;
		modelSearchQuery = '';
		availableModels = [];
		// Keep selectedModels to allow cross-user model comparisons
		modelLoadError = null;

		// Load user's models
		modelSearchLoading = true;
		try {
			const models = await numeraiApi.getUserModels(user.username);

			availableModels = models
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			if (models.length === 0) {
				modelLoadError = `No models found for user "${user.username}"`;
			}
		} catch (error) {
			console.error('Error loading user models:', error);
			availableModels = [];
			modelLoadError = `Failed to load models for "${user.username}": ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			modelSearchLoading = false;
		}

		// Update URL with user parameter
		updateUrlParams();
	}

	function addModel(model: NumeraiModel) {

		if (!selectedModels.find(m => m.id === model.id)) {
			selectedModels = [...selectedModels, model];
			// Clear search state after adding
			modelSearchQuery = '';
			modelSearchResults = [];

			// Track recent user/model combination
			addRecentUserModel(model.username, model.name);
			recentUserModels = getRecentUserModels();

			// Update URL with new model selection
			updateUrlParams();
		}
	}

	function removeModel(modelId: string) {
		selectedModels = selectedModels.filter(m => m.id !== modelId);

		// Update URL after removing model
		updateUrlParams();
	}

	async function loadModelPerformance() {
		if (selectedModels.length === 0) return;

		loadingPerformance = true;
		performanceError = null;
		try {
			modelPerformance = await numeraiApi.getModelPerformanceFromModels(selectedModels);

			// Check if we got any data
			if (modelPerformance.length === 0) {
				performanceError = 'No performance data was retrieved. The models may not be accessible or may not have performance data yet.';
			} else {
				// Update URL - use model names instead of IDs for compatibility with v3UserProfile API
				const modelNames = selectedModels.map(m => m.name);
				updateUrlWithChart({
					models: modelNames,
					startDate,
					endDate,
					name: chartName
				});

				// Generate shareable URL
				shareableUrl = generateShareableUrl({
					models: modelNames,
					startDate,
					endDate,
					name: chartName
				});

				// Track recent chart
				addRecentChart({
					name: chartName,
					models: selectedModels.map(m => m.name),
					startDate,
					endDate
				});
				recentCharts = getRecentCharts();
			}
		} catch (error) {
			console.error('Error loading model performance:', error);
			modelPerformance = [];

			// Set user-friendly error message
			if (error instanceof Error) {
				if (error.message.includes('permission')) {
					performanceError = 'Permission denied: You may not have permission to view these specific models.';
				} else if (error.message.includes('not found')) {
					performanceError = 'Model not found: One or more of the selected models could not be found.';
				} else {
					performanceError = `Error loading performance data: ${error.message}`;
				}
			} else {
				performanceError = 'An unknown error occurred while loading performance data.';
			}
		}
		loadingPerformance = false;
	}

	function saveCurrentChart() {
		if (!chartName || selectedModels.length === 0) return;

		const chart: SavedChart = {
			id: Date.now().toString(),
			name: chartName,
			models: selectedModels.map(m => m.id),
			dateRange: { start: startDate, end: endDate },
			createdAt: new Date().toISOString()
		};

		saveChart(chart);
		savedCharts = getSavedCharts();
	}

	function loadSavedChart(chart: SavedChart) {
		chartName = chart.name;
		startDate = chart.dateRange.start;
		endDate = chart.dateRange.end;
		// Would need to resolve model IDs back to model objects
		// This would require additional API calls or storing more data
	}

	// Preset time range functions
	function setTimeRange(days: number) {
		const now = new Date();
		const pastDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
		startDate = pastDate.toISOString().split('T')[0];
		endDate = now.toISOString().split('T')[0];
	}

	function setLast30Days() {
		setTimeRange(30);
	}

	function setLast3Months() {
		setTimeRange(90);
	}

	function setLastYear() {
		setTimeRange(365);
	}

	function clearUserCache() {
		numeraiApi.clearUserCache();
		userSearchResults = [];
		userSearchQuery = '';
	}

	function clearUserSelection() {
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		availableModels = [];
		// Keep selectedModels to allow cross-user model comparisons
		modelLoadError = null;
		updateUrlParams();
	}

	function handleUserSearchInput(nextQuery: string) {
		if (!selectedUser || nextQuery === selectedUser.username) {
			return;
		}

		selectedUser = null;
		availableModels = [];
		modelSearchQuery = '';
		modelLoadError = null;
		updateUrlParams();
	}

	async function loadModelsFromNames(modelNames: string[]) {
		if (!numeraiApi || modelNames.length === 0) return;


		try {
			const models = await numeraiApi.getModelsByNames(modelNames);

			if (models.length > 0) {
				// Add these models to selected models, avoiding duplicates
				const newModels = models.filter(model =>
					!selectedModels.find(existing => existing.id === model.id)
				);

				if (newModels.length > 0) {
					selectedModels = [...selectedModels, ...newModels];
				}
			}
		} catch (error) {
			console.error('Error loading models from names:', error);
			// Store the names to try loading when a user is selected
			window.pendingModelNames = modelNames;
		}
	}

	async function searchModelsByName() {
		if (!numeraiApi) return;

		const query = modelSearchQuery.trim();
		if (!query) {
			modelSearchResults = [];
			return;
		}

		modelSearchLoading = true;

		const lowerQuery = query.toLowerCase();
		const recentMatchNames = recentUserModels
			.map((recent) => recent.model)
			.filter((modelName) => modelName.toLowerCase().includes(lowerQuery));

		let remoteMatches: NumeraiModel[] = [];
		let recentMatches: NumeraiModel[] = [];
		try {
			remoteMatches = await numeraiApi.getModelsByNames([query]);
			if (recentMatchNames.length > 0) {
				recentMatches = await numeraiApi.getModelsByNames(recentMatchNames);
			}
		} catch (error) {
			console.error('Error searching models by name:', error);
		}

		const combined = [...remoteMatches, ...recentMatches].filter(
			(model, index, arr) => arr.findIndex((entry) => entry.id === model.id) === index
		);

		modelSearchResults = combined
			.filter((model) => !selectedModels.find((selected) => selected.id === model.id))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		modelSearchLoading = false;
	}

	async function retryLoadModels() {
		if (!selectedUser) return;

		// Reset error state and retry
		modelLoadError = null;
		await selectUser(selectedUser);
	}

	async function copyShareableUrl() {
		if (shareableUrl) {
			await navigator.clipboard.writeText(shareableUrl);
		}
	}

	// Filter available models based on search
	// When user is selected: filter from user's models locally
	// When no user selected: use API search results
	const filteredModels = $derived(
		selectedUser
			? availableModels
				.filter(model => model.name.toLowerCase().includes(modelSearchQuery.toLowerCase()))
				.filter(model => !selectedModels.find(m => m.id === model.id))
			: modelSearchResults
	);


	// Helper function for model search placeholder
	function getModelSearchPlaceholder(): string {
		if (modelSearchLoading) return "Searching...";
		if (selectedUser && availableModels.length === 0) return "No models available for this user";
		if (selectedUser) return "Search user's models...";
		return "Search any model by name (2+ chars)...";
	}

	// Helper function to find the first round with actual performance data
	function getLatestRoundWithData(model: ModelPerformance) {
		return model.rounds.find(round => round.correlation !== null || round.mmc !== null) ?? model.rounds[0];
	}

	// Sort model performance by correlation (best performing first)
	const sortedModelPerformance = $derived(
		[...modelPerformance].sort((a, b) => {
			const aRound = getLatestRoundWithData(a);
			const bRound = getLatestRoundWithData(b);
			const aCorr = aRound?.correlation ?? -Infinity;
			const bCorr = bRound?.correlation ?? -Infinity;
			return bCorr - aCorr; // Descending order (highest first)
		})
	);

	// URL query parameter management
	function updateUrlParams() {
		if (!browser) return;

		const url = new URL(window.location.href);

		// Update user parameter
		if (selectedUser && selectedUser.username) {
			url.searchParams.set('user', selectedUser.username);
		} else {
			url.searchParams.delete('user');
		}

		// Update models parameter with defensive checks
		if (selectedModels.length > 0) {
			const modelNames = selectedModels
				.filter(m => m && m.name)  // Filter out invalid models
				.map(m => m.name)
				.join(',');
			if (modelNames) {  // Only set if we have valid names
				url.searchParams.set('models', modelNames);
			} else {
				url.searchParams.delete('models');
			}
		} else {
			url.searchParams.delete('models');
		}

		// Update date range if set
		if (startDate && endDate) {
			url.searchParams.set('startDate', startDate);
			url.searchParams.set('endDate', endDate);
		}

		// Update chart name if set
		if (chartName) {
			url.searchParams.set('name', chartName);
		} else {
			url.searchParams.delete('name');
		}

		replaceState(url.toString(), {});
	}

	async function loadFromUrlParams() {
		if (!browser) return;

		const url = new URL(window.location.href);
		const userParam = url.searchParams.get('user');
		const chartNameParam = url.searchParams.get('name');
		const startDateParam = url.searchParams.get('startDate');
		const endDateParam = url.searchParams.get('endDate');
		const modelsParam = url.searchParams.get('models');

		// Load chart name
		if (chartNameParam) {
			chartName = chartNameParam;
		}

		// Load date range
		if (startDateParam && endDateParam) {
			startDate = startDateParam;
			endDate = endDateParam;
		}

		// Load models from URL first to preserve them across user loading
		if (modelsParam) {
			const modelNames = modelsParam.split(',').map(name => name.trim());

			// Try to load models directly by name
			await loadModelsFromNames(modelNames);
		}

		// Load user if specified
		if (userParam && !selectedUser) {
			// Set the search query to match the user
			userSearchQuery = userParam;

			// Force a search to populate userSearchResults
			await searchUsers();

			// Try to find user in search results after search
			let user = userSearchResults.find(u => u.username === userParam);

			if (!user) {
				// If still not found after search, create a synthetic user object
				user = { id: userParam, username: userParam };
			}

			await selectUser(user);
		}
	}

	// Recent dropdown handlers
	function toggleRecentDropdown() {
		showRecentDropdown = !showRecentDropdown;
	}

	function closeRecentDropdown() {
		showRecentDropdown = false;
	}

	async function loadRecentUserModel(recent: RecentUserModel) {
		closeRecentDropdown();

		// Create a synthetic user object and select it
		const user: NumeraiUser = { id: recent.user, username: recent.user };
		await selectUser(user);

		// Try to find and add the model
		const model = availableModels.find(m => m.name === recent.model);
		if (model) {
			addModel(model);
		}
	}

	async function loadRecentChart(recent: RecentChart) {
		closeRecentDropdown();

		// Load the chart configuration
		startDate = recent.startDate;
		endDate = recent.endDate;
		chartName = recent.name;

		// Load models by name
		await loadModelsFromNames(recent.models);
	}

	// Effect to update URL when date range or chart name changes
	$effect(() => {
		// Only update URL for startDate, endDate, and chartName changes
		// User and model updates are handled in their respective functions
		if ((selectedUser || selectedModels.length > 0) && (startDate || endDate || chartName)) {
			updateUrlParams();
		}
	});

	// Close dropdown when clicking outside
	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.recent-dropdown-container')) {
			showRecentDropdown = false;
		}
	}
</script>

<svelte:head>
	<title>NMR - Numerai Model Reviewer</title>
</svelte:head>

<svelte:window onclick={handleClickOutside} />

<div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
	<div class="mb-8">
		<h1 class="text-3xl font-bold retro-text-accent uppercase tracking-wider">NMR - NUMERAI MODEL REVIEWER</h1>
		<p class="mt-2 retro-text-secondary">Compare model performance across different time periods</p>
	</div>

	<!-- Model Selection -->
	<div id="section-model-selection" class="mb-6 rounded-lg retro-card p-6">
		<div class="mb-4 flex items-center justify-between">
			<h2 id="heading-select-models" class="text-lg font-medium retro-text-primary uppercase">Select Models</h2>
			<div class="flex gap-2">
				<!-- Recent Dropdown -->
				<div id="recent-dropdown-container" class="relative recent-dropdown-container">
					<button
						id="btn-recent-dropdown"
						onclick={toggleRecentDropdown}
						class="retro-button rounded-md px-3 py-2 text-sm font-medium flex items-center gap-1"
						title="Load recent searches and charts"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						Recent
					</button>

					{#if showRecentDropdown}
						<div class="absolute right-0 mt-2 w-72 rounded-lg retro-bg-secondary shadow-lg border-2 border-[var(--retro-crimson)] z-50">
							<div class="p-2">
								{#if recentUserModels.length > 0}
									<div class="mb-2">
										<div class="px-3 py-1 text-xs font-semibold retro-text-secondary uppercase">Recent User/Models</div>
										{#each recentUserModels as recent}
											<button
												onclick={() => loadRecentUserModel(recent)}
												class="w-full text-left px-3 py-2 text-sm rounded hover:retro-bg-primary flex flex-col"
											>
												<span class="font-medium retro-text-primary">{recent.model}</span>
												<span class="text-xs retro-text-secondary">by {recent.user}</span>
											</button>
										{/each}
									</div>
								{/if}

								{#if recentCharts.length > 0}
									<div>
										{#if recentUserModels.length > 0}
											<hr class="my-2 border-[var(--retro-light-grey)]" />
										{/if}
										<div class="px-3 py-1 text-xs font-semibold retro-text-secondary uppercase">Recent Charts</div>
										{#each recentCharts as recent}
											<button
												onclick={() => loadRecentChart(recent)}
												class="w-full text-left px-3 py-2 text-sm rounded hover:retro-bg-primary flex flex-col"
											>
												<span class="font-medium retro-text-primary">{recent.name}</span>
												<span class="text-xs retro-text-secondary">{recent.models.length} models - {recent.startDate} to {recent.endDate}</span>
											</button>
										{/each}
									</div>
								{/if}

								{#if recentUserModels.length === 0 && recentCharts.length === 0}
									<div class="px-3 py-4 text-sm retro-text-secondary text-center">
										No recent items yet
									</div>
								{/if}
							</div>
						</div>
					{/if}
				</div>

				<button
					id="btn-clear-cache"
					onclick={clearUserCache}
					class="retro-button rounded-md px-3 py-2 text-sm font-medium"
					title="Clear user search cache to refresh data"
				>
					Clear Cache
				</button>
			</div>
		</div>

		<div id="search-grid" class="grid gap-4 md:grid-cols-2">
			<!-- User Search -->
			<div id="user-search-container">
				<div class="flex items-center justify-between">
					<label for="userSearch" class="block text-sm font-medium retro-text-primary">Search Users</label>
					{#if userSearchLoading}
						<span class="text-xs retro-text-accent">Searching leaderboard...</span>
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
							id="btn-clear-user"
							onclick={clearUserSelection}
							class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 retro-text-secondary hover:retro-bg-secondary hover:retro-text-primary"
							title="Change user"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
							</svg>
						</button>
					{/if}
				</div>
				<p class="mt-1 text-xs retro-text-primary">
					Search uses paginated leaderboard data. May take a moment for uncommon usernames.
				</p>
			</div>

			<!-- Model Search -->
			<div id="model-search-container">
				<div class="flex items-center justify-between">
					<label for="modelSearch" class="block text-sm font-medium retro-text-primary">Search Models</label>
					{#if modelSearchLoading}
						<span class="text-xs retro-text-accent">Searching...</span>
					{:else if selectedUser && availableModels.length > 0}
						<span class="text-xs retro-text-success">{availableModels.length} models from {selectedUser.username}</span>
					{:else if !selectedUser}
						<span class="text-xs retro-text-secondary">Search all models</span>
					{/if}
				</div>

				{#if modelLoadError}
					<div class="mt-1 rounded-md bg-[var(--retro-error)]/20 border border-[var(--retro-error)] p-2">
						<div class="flex items-center justify-between">
							<span class="text-sm retro-text-error">{modelLoadError}</span>
							<button
								id="btn-retry-load-models"
								onclick={retryLoadModels}
								disabled={modelSearchLoading}
								class="ml-2 rounded px-2 py-1 text-xs retro-text-error hover:bg-[var(--retro-error)]/30 disabled:opacity-50"
							>
								Retry
							</button>
						</div>
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

				<p class="mt-1 text-xs retro-text-secondary">
					{#if selectedUser}
						Searching {selectedUser.username}'s models. Clear user to search all models.
					{:else}
						Type 2+ characters to search all models by name.
					{/if}
				</p>
			</div>
		</div>

		<!-- Selected Models -->
		{#if selectedModels.length > 0}
			<div id="selected-models-container" class="mt-4">
				<h3 id="heading-selected-models" class="text-sm font-medium retro-text-primary">Selected Models</h3>
				<div id="selected-models-list" class="mt-2 flex flex-wrap gap-2">
					{#each selectedModels as model}
						<span class="inline-flex items-center rounded-full bg-[var(--retro-crimson)]/30 border border-[var(--retro-crimson)] px-3 py-1 text-sm retro-text-primary">
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

	<!-- Date Range and Chart Controls -->
	<div id="section-chart-config" class="mb-6 rounded-lg retro-card p-6">
		<h2 id="heading-chart-config" class="mb-4 text-lg font-medium retro-text-primary uppercase">Chart Configuration</h2>

		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="startDate" class="block text-sm font-medium retro-text-primary">Start Date</label>
				<input
					id="startDate"
					type="date"
					bind:value={startDate}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm focus:outline-none"
				/>
			</div>

			<div>
				<label for="endDate" class="block text-sm font-medium retro-text-primary">End Date</label>
				<input
					id="endDate"
					type="date"
					bind:value={endDate}
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm focus:outline-none"
				/>
			</div>

			<div>
				<label for="chartName" class="block text-sm font-medium retro-text-primary">Chart Name</label>
				<input
					id="chartName"
					type="text"
					bind:value={chartName}
					placeholder="Optional chart name"
					class="retro-input mt-1 w-full rounded-md px-3 py-2 text-sm focus:outline-none"
				/>
			</div>
		</div>

		<!-- Preset Time Range Buttons -->
		<div class="mt-4 flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium retro-text-primary">Quick Range:</span>
			<button
				onclick={setLast30Days}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-crimson)] transition-colors"
			>
				30 Days
			</button>
			<button
				onclick={setLast3Months}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-crimson)] transition-colors"
			>
				3 Months
			</button>
			<button
				onclick={setLastYear}
				class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:retro-bg-primary hover:border-[var(--retro-crimson)] transition-colors"
			>
				1 Year
			</button>

			<div class="ml-auto"></div>
		</div>

		<div id="chart-actions" class="mt-4 flex gap-4">
			<button
				id="btn-load-performance"
				onclick={loadModelPerformance}
				disabled={selectedModels.length === 0 || loadingPerformance}
				class="retro-button rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
			>
				{loadingPerformance ? 'Loading...' : 'Load Performance Data'}
			</button>

			<button
				id="btn-save-chart"
				onclick={saveCurrentChart}
				disabled={!chartName || selectedModels.length === 0}
				class="rounded-md bg-[var(--retro-success)] px-4 py-2 text-sm font-medium text-black hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Save Chart
			</button>

			{#if shareableUrl}
				<button
					id="btn-copy-url"
					onclick={copyShareableUrl}
					class="rounded-md retro-bg-secondary border-2 border-[var(--retro-light-grey)] px-4 py-2 text-sm font-medium retro-text-primary hover:retro-bg-primary"
				>
					Copy Shareable URL
				</button>
			{/if}
		</div>

		<!-- Performance Error -->
		{#if performanceError}
			<div class="mt-4 rounded-md bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] p-4">
				<div class="flex">
					<div class="ml-3">
						<h3 class="text-sm font-medium retro-text-warning">
							Performance Data Issue
						</h3>
						<div class="mt-2 text-sm retro-text-warning">
							<p>{performanceError}</p>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Performance Chart -->
	{#if modelPerformance.length > 0}
		<div class="mb-6 rounded-lg retro-card p-6">
			<div class="mb-4">
				<h3 class="text-lg font-medium retro-text-primary uppercase">Model Performance Comparison</h3>
				<p class="text-sm retro-text-secondary mt-1">Latest performance metrics for selected models (bar chart)</p>
			</div>

			<!-- Simple Bar Chart for Current Metrics -->
			<div class="space-y-6">
				<!-- Correlation Comparison -->
				<div>
					<h4 class="text-sm font-medium retro-text-primary mb-2">Corr20 Comparison</h4>
					<div class="space-y-2">
						{#each sortedModelPerformance as model, index}
							{@const latestRound = getLatestRoundWithData(model)}
							{@const correlation = latestRound?.correlation}
							{@const maxCorr = Math.max(...sortedModelPerformance.map(m => getLatestRoundWithData(m)?.correlation || 0))}
							{@const minCorr = Math.min(...sortedModelPerformance.map(m => getLatestRoundWithData(m)?.correlation || 0))}
							{@const range = maxCorr - minCorr || 1}
							{@const barWidth = correlation !== null && correlation !== undefined ? Math.abs((correlation - minCorr) / range) * 100 : 0}
							<div class="flex items-center gap-3">
								<div class="w-32 text-sm retro-text-secondary truncate" title="{model.modelName} ({model.username})">
									{model.modelName}
								</div>
								<div class="flex-1 retro-bg-secondary rounded-full h-6 relative">
									{#if correlation !== null && correlation !== undefined}
										<div
											class="h-6 rounded-full flex items-center justify-end pr-2 text-xs text-white font-medium {correlation > 0 ? 'bg-[var(--retro-success)]' : 'bg-[var(--retro-error)]'}"
											style="width: {Math.max(barWidth, 10)}%"
										>
											{correlation.toFixed(4)}
										</div>
									{:else}
										<div class="h-6 rounded-full retro-bg-primary flex items-center justify-center text-xs retro-text-secondary">
											N/A
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- MMC Comparison -->
				<div>
					<h4 class="text-sm font-medium retro-text-primary mb-2">MMC Comparison</h4>
					<div class="space-y-2">
						{#each sortedModelPerformance as model, index}
							{@const latestRound = getLatestRoundWithData(model)}
							{@const mmc = latestRound?.mmc}
							{@const maxMmc = Math.max(...sortedModelPerformance.map(m => getLatestRoundWithData(m)?.mmc || 0))}
							{@const minMmc = Math.min(...sortedModelPerformance.map(m => getLatestRoundWithData(m)?.mmc || 0))}
							{@const range = maxMmc - minMmc || 1}
							{@const barWidth = mmc !== null && mmc !== undefined ? Math.abs((mmc - minMmc) / range) * 100 : 0}
							<div class="flex items-center gap-3">
								<div class="w-32 text-sm retro-text-secondary truncate" title="{model.modelName} ({model.username})">
									{model.modelName}
								</div>
								<div class="flex-1 retro-bg-secondary rounded-full h-6 relative">
									{#if mmc !== null && mmc !== undefined}
										<div
											class="h-6 rounded-full flex items-center justify-end pr-2 text-xs text-white font-medium {mmc > 0 ? 'bg-[var(--retro-crimson)]' : 'bg-[var(--retro-accent)]'}"
											style="width: {Math.max(barWidth, 10)}%"
										>
											{mmc.toFixed(4)}
										</div>
									{:else}
										<div class="h-6 rounded-full retro-bg-primary flex items-center justify-center text-xs retro-text-secondary">
											N/A
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Time Series Performance Chart -->
	{#if modelPerformance.length > 0}
		<div class="mb-6 rounded-lg retro-card p-6">
			<div class="mb-4">
				<h3 class="text-lg font-medium retro-text-primary uppercase">Performance Over Time</h3>
				<p class="text-sm retro-text-secondary mt-1">
					Historical performance metrics for selected models (dual-axis: left for Corr/MMC/FNC, right for TC/Payout)
				</p>
			</div>

			<TimeSeriesChart
				{modelPerformance}
				{startDate}
				{endDate}
			/>
		</div>
	{/if}

	<!-- Performance Table -->
	{#if modelPerformance.length > 0}
		<div class="rounded-lg retro-card">
			<div class="px-6 py-4 border-b retro-border-secondary border-2">
				<h2 class="text-lg font-medium retro-text-primary uppercase">Latest Model Performance</h2>
				<p class="text-sm retro-text-secondary mt-1">Current performance metrics for selected models</p>
			</div>

			<div class="overflow-x-auto">
				<table class="min-w-full divide-y retro-border-secondary border-2">
					<thead class="retro-bg-secondary">
						<tr>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Model</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">User</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Corr20</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">MMC</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">FNC</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Stake Value</th>
							<th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider retro-text-primary">Corr Multiplier</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
						{#each sortedModelPerformance as model}
							{@const latestRound = getLatestRoundWithData(model)}
							<tr>
								<td class="whitespace-nowrap px-6 py-4 text-sm font-medium retro-text-primary">{model.modelName}</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">{model.username}</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">
									{#if latestRound?.correlation !== null && latestRound?.correlation !== undefined}
										<span class="{latestRound.correlation > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{latestRound.correlation.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">
									{#if latestRound?.mmc !== null && latestRound?.mmc !== undefined}
										<span class="{latestRound.mmc > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{latestRound.mmc.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">
									{#if latestRound?.fnc !== null && latestRound?.fnc !== undefined}
										<span class="{latestRound.fnc > 0 ? 'retro-text-success' : 'retro-text-error'}">
											{latestRound.fnc.toFixed(4)}
										</span>
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">
									{#if model.stakeValue !== null && model.stakeValue !== undefined && typeof model.stakeValue === 'number'}
										{model.stakeValue.toFixed(2)} NMR
									{:else if latestRound?.selectedStakeValue !== null && latestRound?.selectedStakeValue !== undefined && typeof latestRound.selectedStakeValue === 'number'}
										{latestRound.selectedStakeValue.toFixed(2)} NMR
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
								<td class="whitespace-nowrap px-6 py-4 text-sm retro-text-primary">
									{#if model.stakeInfo?.corrMultiplier !== null && model.stakeInfo?.corrMultiplier !== undefined}
										{model.stakeInfo.corrMultiplier.toFixed(2)}x
									{:else if latestRound?.corrMultiplier !== null && latestRound?.corrMultiplier !== undefined}
										{latestRound.corrMultiplier.toFixed(2)}x
									{:else}
										<span class="retro-text-secondary">N/A</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Saved Charts -->
	{#if savedCharts.length > 0}
		<div class="mt-6 rounded-lg retro-card p-6">
			<h2 class="mb-4 text-lg font-medium retro-text-primary uppercase">Saved Charts</h2>
			<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each savedCharts as chart}
					<div class="rounded-lg border border-[var(--retro-light-grey)] p-4">
						<h3 class="font-medium retro-text-primary">{chart.name}</h3>
						<p class="text-sm retro-text-primary">{chart.models.length} models</p>
						<p class="text-sm retro-text-primary">{chart.dateRange.start} to {chart.dateRange.end}</p>
						<button
							onclick={() => loadSavedChart(chart)}
							class="retro-button mt-2 rounded-md px-3 py-1 text-sm"
						>
							Load
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
