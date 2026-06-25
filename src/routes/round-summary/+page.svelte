<script lang="ts">
	import { onMount } from 'svelte';
	import Autocomplete from '$lib/components/Autocomplete.svelte';
	import DistributionChart, { type Highlight } from '$lib/components/DistributionChart.svelte';
	import { NumeraiAPI } from '$lib/numerai-api.js';
	import { config } from '$lib/config.js';
	import {
		getTopModelsForRound,
		getCurrentRound,
		getCacheStatus,
		getDefaultFormulaForTournament,
		calculateCustomScore
	} from '$lib/rankings-api.js';
	import type {
		NumeraiUser,
		NumeraiModel,
		ScoreFormula,
		RoundModelScore,
		ModelPerformance,
		RoundPerformance
	} from '$lib/types.js';
	import {
		getSelectedTournament,
		setSelectedTournament,
		TOURNAMENTS,
		TOURNAMENT_INFO,
		type TournamentId
	} from '$lib/utils/storage.js';
	import { formatModelOption } from '$lib/utils/format-model-option.js';
	import { computeHistogram, binIndexOf } from '$lib/utils/histogram.js';
	import { paginateModels } from '$lib/utils/paginate-models.js';
	import {
		metricOptions,
		metricLabel,
		metricValue,
		type RoundSummaryMetric
	} from '$lib/utils/round-summary-metric.js';
	import { rankToPercentile, formatPercentile } from '$lib/utils/ranking-display.js';
	import {
		sortRoundModels,
		defaultDirFor,
		type SortKey,
		type SortDir
	} from '$lib/utils/round-summary-sort.js';
	import { replaceState } from '$app/navigation';
	import { browser } from '$app/environment';

	let numeraiApi: NumeraiAPI;

	// Tournament
	let selectedTournament = $state<TournamentId>(TOURNAMENTS.CLASSIC);
	const themeClass = $derived(TOURNAMENT_INFO[selectedTournament].theme);
	const isSignals = $derived(selectedTournament === TOURNAMENTS.SIGNALS);
	const metric1Label = $derived(isSignals ? 'Alpha' : 'CORR');
	const metric2Label = $derived(isSignals ? 'MPC' : 'MMC');
	const scoreFormulaDefault = $derived(getDefaultFormulaForTournament(selectedTournament));

	// User + model selection
	let userSearchQuery = $state('');
	let userSearchResults = $state<NumeraiUser[]>([]);
	let userSearchLoading = $state(false);
	let selectedUser = $state<NumeraiUser | null>(null);
	let availableModels = $state<NumeraiModel[]>([]);
	let modelSearchQuery = $state('');
	let modelSearchLoading = $state(false);
	let modelLoadError = $state<string | null>(null);
	let selectedModels = $state<NumeraiModel[]>([]);

	// When no models are picked, highlight all of the selected user's models.
	const modelsToHighlight = $derived(
		selectedModels.length > 0 ? selectedModels : selectedUser ? availableModels : []
	);
	const usingAllUserModels = $derived(selectedModels.length === 0 && modelsToHighlight.length > 0);

	// Round + metric + payout formula
	let currentRound = $state(0);
	let cacheLatestRound = $state<number | null>(null);
	let cacheEarliestRound = $state<number | null>(null);
	let round = $state(0);
	let metric = $state<RoundSummaryMetric>('metric2'); // MMC, matching the reference view
	let scoreFormula = $state<ScoreFormula>(getDefaultFormulaForTournament(TOURNAMENTS.CLASSIC));

	// Bounds for the round selector: the cached range when known, else 1..current.
	const roundMin = $derived(cacheEarliestRound ?? 1);
	const roundMax = $derived(cacheLatestRound ?? (currentRound > 0 ? currentRound : 9999));

	function setRound(next: number) {
		round = Math.min(roundMax, Math.max(roundMin, next));
		updateUrl();
	}

	// The newest cached round may still be settling: the bars come from the
	// precompute snapshot while unstaked diamonds are live, so they can differ
	// slightly on this round only. Older rounds are exact.
	const latestRoundSettling = $derived(cacheLatestRound !== null && round === cacheLatestRound);

	// Data
	let field = $state<RoundModelScore[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	const isPercentileMetric = $derived(metric === 'percentile');
	const formatValue = $derived((n: number) =>
		isPercentileMetric ? formatPercentile(n) : n.toFixed(4)
	);

	// Distribution bins over the chosen metric across the staked field.
	const bins = $derived(
		computeHistogram(
			field.map((m) => metricValue(m, metric)).filter((v): v is number => v !== null),
			30
		)
	);

	// Every staked model's (name, metric value) so each bar can list its members.
	const points = $derived.by(() => {
		const out: { label: string; value: number }[] = [];
		for (const m of field) {
			const v = metricValue(m, metric);
			if (v !== null) out.push({ label: m.modelName, value: v });
		}
		return out;
	});

	// Match each highlight model (by name) to its row in the field.
	const matched = $derived.by(() => {
		const byName = new Map(field.map((m) => [m.modelName.toLowerCase(), m]));
		const found: RoundModelScore[] = [];
		const missing: string[] = [];
		for (const m of modelsToHighlight) {
			const row = byName.get(m.name.toLowerCase());
			if (row) found.push(row);
			else missing.push(m.name);
		}
		return { found, missing };
	});

	// Bar selection: clicking a bar adds that bin's models to the table.
	let selectedBin = $state(-1);
	function handleBarSelect(idx: number) {
		selectedBin = selectedBin === idx ? -1 : idx;
		tablePage = 1;
	}
	const selectedBinObj = $derived(selectedBin >= 0 ? (bins[selectedBin] ?? null) : null);

	// Full model rows that fall in the selected bar (for the table).
	const barModels = $derived.by<RoundModelScore[]>(() => {
		if (selectedBin < 0) return [];
		return field.filter((m) => {
			const v = metricValue(m, metric);
			return v !== null && binIndexOf(v, bins) === selectedBin;
		});
	});

	// Names of "your" models, used to flag rows and to dedupe the union.
	const yourNames = $derived(new Set(matched.found.map((m) => m.modelName.toLowerCase())));

	// Table rows: your models, plus the selected bar's models (deduped).
	const tableModels = $derived.by<RoundModelScore[]>(() => {
		if (selectedBin < 0) return matched.found;
		const seen = new Set(yourNames);
		const merged = [...matched.found];
		for (const m of barModels) {
			const key = m.modelName.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				merged.push(m);
			}
		}
		return merged;
	});

	// Table sorting: click a header to sort; click again toggles asc/desc.
	let sortKey = $state<SortKey>('rank');
	let sortDir = $state<SortDir>('asc');
	function toggleSort(key: SortKey) {
		if (key === sortKey) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = defaultDirFor(key);
		}
		tablePage = 1;
	}
	const sortedRows = $derived(sortRoundModels(tableModels, sortKey, sortDir));

	// Pagination: 100 rows per page (a peak bar can hold thousands of models).
	const TABLE_PAGE_SIZE = 100;
	let tablePage = $state(1);
	const pagedRows = $derived(paginateModels(sortedRows, '', tablePage, TABLE_PAGE_SIZE));
	const sortArrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
	const tableCols = $derived(
		[
			{ key: 'model', label: 'Model' },
			{ key: 'metric1', label: metric1Label },
			{ key: 'metric2', label: metric2Label },
			{ key: 'score', label: 'Payout score' },
			{ key: 'rank', label: 'Rank' },
			{ key: 'percentile', label: 'Percentile' }
		] as { key: SortKey; label: string }[]
	);

	const highlights = $derived.by<Highlight[]>(() => {
		const out: Highlight[] = [];
		for (const m of matched.found) {
			const value = metricValue(m, metric);
			if (value === null) continue;
			const pct = rankToPercentile(m.rank, m.totalModels);
			out.push({
				label: m.modelName,
				value,
				detail: `Rank ${m.rank ?? '—'} / ${m.totalModels}${pct !== null ? ` · ${formatPercentile(pct)} pct` : ''}`,
				variant: 'staked'
			});
		}
		return out;
	});

	// Unstaked models (opt-in: extra per-model API calls). Their values come from
	// the per-model performance API, not the staked cache. Skipped for the
	// percentile metric (an unstaked model has no rank in the staked field).
	let showUnstaked = $state(false);
	let loadingUnstaked = $state(false);
	let unstakedPerf = $state<Record<string, ModelPerformance>>({});

	async function loadUnstaked() {
		if (!showUnstaked || metric === 'percentile' || matched.missing.length === 0) return;
		const missingSet = new Set(matched.missing.map((n) => n.toLowerCase()));
		const models = modelsToHighlight.filter((m) => missingSet.has(m.name.toLowerCase()));
		if (models.length === 0) return;
		loadingUnstaked = true;
		try {
			const perfs = await numeraiApi.getModelPerformanceFromModels(models);
			const map: Record<string, ModelPerformance> = {};
			for (const p of perfs) map[p.modelName.toLowerCase()] = p;
			unstakedPerf = map;
		} catch (e) {
			console.error('Error loading unstaked performance:', e);
		} finally {
			loadingUnstaked = false;
		}
	}

	function toggleUnstaked() {
		showUnstaked = !showUnstaked;
		if (showUnstaked) loadUnstaked();
	}

	/** Value of a per-model round under the active metric (matches the bars' semantics). */
	function perfMetricValue(r: RoundPerformance): number | null {
		const m1 = isSignals ? (r.alpha ?? null) : r.correlation;
		const m2 = isSignals ? (r.mpc ?? null) : r.mmc;
		if (metric === 'metric1') return m1;
		if (metric === 'metric2') return m2;
		if (metric === 'score') return calculateCustomScore(m1, m2, null, scoreFormula);
		return null; // percentile: not placeable for unstaked
	}

	const unstakedHighlights = $derived.by<Highlight[]>(() => {
		if (!showUnstaked || metric === 'percentile') return [];
		const out: Highlight[] = [];
		for (const name of matched.missing) {
			const perf = unstakedPerf[name.toLowerCase()];
			const r = perf?.rounds.find((x) => x.roundNumber === round);
			if (!r) continue;
			const value = perfMetricValue(r);
			if (value === null || !Number.isFinite(value)) continue;
			out.push({ label: name, value, detail: 'Unstaked — not in the staked field', variant: 'unstaked' });
		}
		return out;
	});

	const allHighlights = $derived([...highlights, ...unstakedHighlights]);

	onMount(async () => {
		numeraiApi = new NumeraiAPI();

		// Tournament from URL or storage.
		const url = new URL(window.location.href);
		const tParam = url.searchParams.get('tournament');
		const parsedT = tParam ? (parseInt(tParam, 10) as TournamentId) : null;
		selectedTournament =
			parsedT === TOURNAMENTS.CLASSIC || parsedT === TOURNAMENTS.SIGNALS || parsedT === TOURNAMENTS.CRYPTO
				? parsedT
				: getSelectedTournament();
		setSelectedTournament(selectedTournament);
		scoreFormula = getDefaultFormulaForTournament(selectedTournament);

		try {
			currentRound = await getCurrentRound(selectedTournament);
		} catch {
			currentRound = 0;
		}
		await refreshCache();
		round = cacheLatestRound ?? Math.max(1, currentRound - 1);

		await loadFromUrl(url);
	});

	/** Resolve user, models, round and metric from the URL, then auto-load. */
	async function loadFromUrl(url: URL) {
		const metricParam = url.searchParams.get('metric') as RoundSummaryMetric | null;
		if (metricParam && metricOptions(selectedTournament).some((o) => o.key === metricParam)) {
			metric = metricParam;
		}

		const roundParam = url.searchParams.get('round');
		if (roundParam) {
			const r = parseInt(roundParam, 10);
			if (Number.isFinite(r) && r > 0) round = r;
		}

		const userParam = url.searchParams.get('user');
		if (userParam) {
			userSearchQuery = userParam;
			await searchUsers();
			const user = userSearchResults.find((u) => u.username === userParam);
			if (user) await selectUser(user);
		}

		const modelsParam = url.searchParams.get('models');
		if (modelsParam) {
			const names = modelsParam.split(',').map((n) => n.trim()).filter(Boolean);
			try {
				const models = await numeraiApi.getModelsByNames(names, selectedTournament, userParam ?? undefined);
				selectedModels = models.filter((m) => m.tournament === selectedTournament);
			} catch (e) {
				console.error('Error loading models from URL:', e);
			}
		}

		// Auto-render when we have a round and someone to mark.
		if (round > 0 && modelsToHighlight.length > 0) {
			await loadSummary();
		}
	}

	function updateUrl() {
		if (!browser) return;
		const url = new URL(window.location.href);
		url.searchParams.set('tournament', selectedTournament.toString());
		url.searchParams.set('round', round.toString());
		url.searchParams.set('metric', metric);
		if (selectedUser?.username) url.searchParams.set('user', selectedUser.username);
		else url.searchParams.delete('user');
		if (selectedModels.length > 0)
			url.searchParams.set('models', selectedModels.map((m) => m.name).join(','));
		else url.searchParams.delete('models');
		replaceState(url.toString(), {});
	}

	async function refreshCache() {
		const status = await getCacheStatus(selectedTournament);
		cacheLatestRound = status?.latestRound ?? null;
		cacheEarliestRound = status?.earliestRound ?? null;
	}

	$effect(() => {
		const q = userSearchQuery;
		if (!numeraiApi) return;
		if (q.length < 2 || (selectedUser && q === selectedUser.username)) {
			if (!selectedUser) userSearchResults = [];
			return;
		}
		const t = setTimeout(searchUsers, 300);
		return () => clearTimeout(t);
	});

	async function searchUsers() {
		userSearchLoading = true;
		try {
			const results = await numeraiApi.searchUsers(userSearchQuery);
			userSearchResults = results
				.slice()
				.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
		} catch (e) {
			console.error('user search failed', e);
			userSearchResults = [];
		}
		userSearchLoading = false;
	}

	async function selectUser(user: NumeraiUser) {
		if (!user?.username) return;
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
			if (models.length === 0)
				modelLoadError = `No ${TOURNAMENT_INFO[selectedTournament].name} models for "${user.username}"`;
		} catch (e) {
			modelLoadError = `Failed to load models: ${e instanceof Error ? e.message : 'Unknown error'}`;
		} finally {
			modelSearchLoading = false;
		}
		updateUrl();
	}

	function clearUser() {
		selectedUser = null;
		userSearchQuery = '';
		userSearchResults = [];
		availableModels = [];
		selectedModels = [];
		modelLoadError = null;
		updateUrl();
	}

	function addModel(model: NumeraiModel) {
		if (!selectedModels.find((m) => m.id === model.id)) selectedModels = [...selectedModels, model];
		modelSearchQuery = '';
		updateUrl();
	}
	function removeModel(id: string) {
		selectedModels = selectedModels.filter((m) => m.id !== id);
		updateUrl();
	}

	const filteredModels = $derived(
		availableModels.filter((m) => !selectedModels.find((s) => s.id === m.id))
	);

	function switchTournament(t: TournamentId) {
		if (t === selectedTournament) return;
		selectedTournament = t;
		setSelectedTournament(t);
		scoreFormula = getDefaultFormulaForTournament(t);
		clearUser();
		field = [];
		error = null;
		getCurrentRound(t)
			.then((r) => (currentRound = r))
			.catch(() => {});
		refreshCache().then(() => {
			round = cacheLatestRound ?? Math.max(1, currentRound - 1);
			updateUrl();
		});
	}

	function updateFormula(key: 'corrWeight' | 'mmcWeight', value: number) {
		scoreFormula = { ...scoreFormula, [key]: value };
	}
	function resetFormula() {
		scoreFormula = getDefaultFormulaForTournament(selectedTournament);
	}

	async function loadSummary() {
		if (round <= 0) return;
		loading = true;
		error = null;
		selectedBin = -1;
		tablePage = 1;
		try {
			// limit=0 → whole ranked staked field for the round.
			field = await getTopModelsForRound(round, scoreFormula, selectedTournament, 0);
			if (field.length === 0) {
				await refreshCache();
				error =
					cacheLatestRound !== null
						? `No staked-model data for round ${round}. Cache covers rounds ${cacheEarliestRound ?? 1}–${cacheLatestRound}.`
						: `No staked-model data for round ${round}.`;
			}
		} catch (e) {
			error = `Failed to load round summary: ${e instanceof Error ? e.message : 'Unknown error'}`;
			field = [];
		} finally {
			loading = false;
		}
		// Refresh unstaked markers against the new field/round if enabled.
		unstakedPerf = {};
		if (showUnstaked) loadUnstaked();
	}
</script>

<div class="mx-auto max-w-5xl px-4 py-8 {themeClass}">
	<h1 class="mb-2 text-3xl font-bold retro-text-accent uppercase tracking-wider">Round Summary</h1>
	<p class="mb-6 text-sm retro-text-secondary">
		Distribution of a metric across all staked models for one round, with your models marked.
	</p>

	<!-- Tournament tabs -->
	<div class="mb-6 flex gap-2">
		{#if config.features.enableClassic}
			<button class="retro-button rounded-md px-4 py-1.5 text-sm" class:opacity-50={selectedTournament !== TOURNAMENTS.CLASSIC} onclick={() => switchTournament(TOURNAMENTS.CLASSIC)}>Classic</button>
		{/if}
		{#if config.features.enableSignals}
			<button class="retro-button rounded-md px-4 py-1.5 text-sm" class:opacity-50={selectedTournament !== TOURNAMENTS.SIGNALS} onclick={() => switchTournament(TOURNAMENTS.SIGNALS)}>Signals</button>
		{/if}
		{#if config.features.enableCrypto}
			<button class="retro-button rounded-md px-4 py-1.5 text-sm" class:opacity-50={selectedTournament !== TOURNAMENTS.CRYPTO} onclick={() => switchTournament(TOURNAMENTS.CRYPTO)}>Crypto</button>
		{/if}
	</div>

	<!-- Selection card -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<div class="grid gap-4 md:grid-cols-2">
			<div>
				<label for="userSearch" class="block text-sm font-medium retro-text-primary">User</label>
				<div class="relative">
					<Autocomplete id="userSearch" bind:value={userSearchQuery} options={userSearchResults.map((u) => ({ id: u.username, label: u.username, value: u }))} placeholder="Search user..." loading={userSearchLoading} selectOnClick={Boolean(selectedUser)} onselect={selectUser} class="mt-1" />
					{#if selectedUser}
						<button onclick={clearUser} class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 retro-text-secondary hover:retro-bg-secondary" title="Change user">✕</button>
					{/if}
				</div>
			</div>
			<div>
				<div class="flex items-center justify-between">
					<label for="modelSearch" class="block text-sm font-medium retro-text-primary">Models (optional)</label>
					{#if selectedUser && availableModels.length > 0}
						<span class="text-xs retro-text-success">{availableModels.length} models</span>
					{/if}
				</div>
				{#if modelLoadError}
					<div class="mt-1 rounded-md bg-[var(--retro-error)]/20 border border-[var(--retro-error)] p-2"><span class="text-sm retro-text-error">{modelLoadError}</span></div>
				{:else}
					<Autocomplete id="modelSearch" bind:value={modelSearchQuery} options={filteredModels.map((m) => ({ id: m.id, label: formatModelOption(m), value: m }))} placeholder={selectedUser ? "Add specific models..." : 'Pick a user first'} disabled={!selectedUser} loading={modelSearchLoading} onselect={addModel} class="mt-1" />
				{/if}
			</div>
		</div>

		{#if selectedModels.length > 0}
			<div class="mt-3 flex flex-wrap gap-2">
				{#each selectedModels as model}
					<span class="inline-flex items-center rounded-full bg-[var(--retro-primary)]/30 border border-[var(--retro-primary)] px-3 py-1 text-sm retro-text-primary">{model.name}<button onclick={() => removeModel(model.id)} class="ml-2 h-4 w-4 rounded-full retro-text-secondary hover:text-white">✕</button></span>
				{/each}
			</div>
		{:else if selectedUser && availableModels.length > 0}
			<p class="mt-3 text-xs retro-text-secondary"><span class="font-medium">Tip:</span> no models selected — all {availableModels.length} of {selectedUser.username}'s models will be marked. Add models to focus on just those.</p>
		{/if}
	</div>

	<!-- Controls: round, metric, payout formula -->
	<div class="mb-6 rounded-lg retro-card p-6">
		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="round" class="block text-sm font-medium retro-text-primary">Round</label>
				<div class="mt-1 flex items-center gap-1">
					<button onclick={() => setRound(round - 1)} disabled={round <= roundMin} class="retro-button rounded-md px-2 py-2 text-sm disabled:opacity-40" title="Previous round" aria-label="Previous round">◀</button>
					<input id="round" type="number" bind:value={round} onchange={() => setRound(round)} min={roundMin} max={roundMax} class="retro-input w-full rounded-md px-3 py-2 text-sm" />
					<button onclick={() => setRound(round + 1)} disabled={round >= roundMax} class="retro-button rounded-md px-2 py-2 text-sm disabled:opacity-40" title="Next round" aria-label="Next round">▶</button>
					<button onclick={() => setRound(roundMax)} disabled={round >= roundMax} class="retro-button rounded-md px-3 py-2 text-sm disabled:opacity-40" title="Jump to latest available round">Latest</button>
				</div>
				{#if cacheLatestRound !== null}
					<p class="mt-1 text-xs retro-text-secondary">Available rounds: {cacheEarliestRound ?? 1}–{cacheLatestRound}{currentRound > 0 ? ` (live round ${currentRound})` : ''}</p>
				{/if}
			</div>
			<div class="md:col-span-2">
				<span class="block text-sm font-medium retro-text-primary mb-1">Metric</span>
				<div class="inline-flex flex-wrap overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
					{#each metricOptions(selectedTournament) as opt}
						<button onclick={() => { metric = opt.key; selectedBin = -1; updateUrl(); }} class="px-3 py-1 text-sm font-medium transition-colors" style={metric === opt.key ? 'background-color: var(--retro-primary); color: white;' : 'color: var(--retro-text-primary);'}>{opt.label}</button>
					{/each}
				</div>
			</div>
		</div>

		<!-- Payout formula (only relevant to the 'Payout score' / 'Percentile' metrics) -->
		<div class="mt-4 grid gap-4 md:grid-cols-2">
			<div>
				<label for="corrW" class="block text-xs font-medium retro-text-primary">{metric1Label} Weight</label>
				<input id="corrW" type="number" step="0.05" value={scoreFormula.corrWeight} onchange={(e) => updateFormula('corrWeight', parseFloat(e.currentTarget.value) || 0)} class="retro-input mt-1 w-full rounded-md px-3 py-1.5 text-sm" />
			</div>
			<div>
				<label for="mmcW" class="block text-xs font-medium retro-text-primary">{metric2Label} Weight</label>
				<input id="mmcW" type="number" step="0.05" value={scoreFormula.mmcWeight} onchange={(e) => updateFormula('mmcWeight', parseFloat(e.currentTarget.value) || 0)} class="retro-input mt-1 w-full rounded-md px-3 py-1.5 text-sm" />
			</div>
		</div>
		<div class="mt-2 flex items-center justify-between">
			<p class="text-xs retro-text-secondary">Payout default: {scoreFormulaDefault.corrWeight}×{metric1Label} + {scoreFormulaDefault.mmcWeight}×{metric2Label}</p>
			<button onclick={resetFormula} class="text-xs retro-text-accent hover:underline">Reset formula</button>
		</div>

		<div class="mt-4">
			<button onclick={loadSummary} disabled={round <= 0 || loading} class="retro-button rounded-md px-6 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50">{loading ? 'Loading...' : 'Load Round Summary'}</button>
			{#if usingAllUserModels}
				<span class="ml-3 text-xs retro-text-secondary">Marking all {modelsToHighlight.length} of {selectedUser?.username}'s models.</span>
			{/if}
		</div>

		{#if error}
			<div class="mt-4 rounded-md bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] p-3"><p class="text-sm retro-text-warning">{error}</p></div>
		{/if}
	</div>

	<!-- Chart -->
	{#if field.length > 0}
		<div class="mb-6 rounded-lg retro-card p-6">
			<h2 class="mb-1 text-lg font-medium retro-text-primary uppercase">Round {round} — {metricLabel(metric, selectedTournament)} distribution</h2>
			<p class="mb-1 text-xs retro-text-secondary">{field.length} staked models. Hover a ◆ to see which model it is.</p>
			{#if latestRoundSettling}
				<p class="mb-3 inline-block rounded bg-[var(--retro-warning)]/20 border border-[var(--retro-warning)] px-2 py-1 text-xs retro-text-warning">
					⚠ Round {round} is the latest cached round and scores may still be settling — bars (cached snapshot) and any live unstaked ◆ can differ slightly. Earlier rounds are exact.
				</p>
			{/if}
			<DistributionChart {bins} highlights={allHighlights} {points} axisLabel={metricLabel(metric, selectedTournament)} signed={!isPercentileMetric} {selectedBin} onBarSelect={handleBarSelect} {formatValue} />
			<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
				<p class="text-xs retro-text-secondary">Click a bar to add its models to the table below.</p>
				{#if isPercentileMetric}
					<span class="text-xs retro-text-secondary">Unstaked markers aren't available for Percentile.</span>
				{:else}
					<div class="flex items-center gap-3">
						<label class="flex items-center gap-2 text-xs retro-text-primary">
							<input type="checkbox" checked={showUnstaked} onchange={toggleUnstaked} />
							Show my unstaked models (extra API calls)
						</label>
						{#if loadingUnstaked}
							<span class="flex items-center gap-2 text-xs retro-text-accent">
								<span class="spinner" aria-hidden="true"></span>
								Loading unstaked models…
							</span>
						{/if}
					</div>
				{/if}
			</div>
			{#if matched.missing.length > 0}
				<p class="mt-3 text-xs retro-text-warning">
					Not staked in round {round}: {matched.missing.join(', ')}{showUnstaked && !isPercentileMetric ? ' — shown as amber ◆ where data exists.' : ' (no marker).'}
				</p>
			{/if}
		</div>

		<!-- Models table: your models + (optionally) a selected bar's models -->
		{#if sortedRows.length > 0}
			<div class="rounded-lg retro-card">
				<div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b-2 retro-border-secondary">
					<p class="text-sm retro-text-secondary">
						{#if selectedBinObj}
							Your models + {barModels.length} model{barModels.length === 1 ? '' : 's'} in selected bar
							({metricLabel(metric, selectedTournament)} {formatValue(selectedBinObj.x0)}–{formatValue(selectedBinObj.x1)})
						{:else}
							Your models for round {round}. Click a bar above to add that bar's models.
						{/if}
					</p>
					{#if selectedBinObj}
						<button onclick={() => (selectedBin = -1)} class="text-xs retro-text-accent hover:underline">Clear bar selection</button>
					{/if}
				</div>
				<div class="overflow-x-auto">
					<table class="min-w-full divide-y retro-border-secondary border-2">
						<thead class="retro-bg-secondary">
							<tr>
								{#each tableCols as col}
									<th class="px-4 py-3 text-left text-xs font-medium uppercase retro-text-primary">
										<button
											onclick={() => toggleSort(col.key)}
											class="inline-flex items-center uppercase hover:retro-text-accent"
											aria-label="Sort by {col.label}"
										>
											{col.label}{sortArrow(col.key)}
										</button>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--retro-light-grey)] retro-bg-primary">
							{#each pagedRows.items as m}
								{@const pct = rankToPercentile(m.rank, m.totalModels)}
								{@const mine = yourNames.has(m.modelName.toLowerCase())}
								<tr class={mine ? 'bg-[var(--retro-primary)]/20' : ''}>
									<td class="px-4 py-3 text-sm font-medium retro-text-primary">
										{m.modelName}{#if mine}<span class="ml-1 text-xs retro-text-accent">◆</span>{/if}
									</td>
									<td class="px-4 py-3 text-sm">{m.corr !== null ? m.corr.toFixed(4) : 'N/A'}</td>
									<td class="px-4 py-3 text-sm">{m.mmc !== null ? m.mmc.toFixed(4) : 'N/A'}</td>
									<td class="px-4 py-3 text-sm">{m.customScore !== null ? m.customScore.toFixed(4) : 'N/A'}</td>
									<td class="px-4 py-3 text-sm">#{m.rank ?? '—'} / {m.totalModels}</td>
									<td class="px-4 py-3 text-sm retro-text-primary">{pct !== null ? formatPercentile(pct) : 'N/A'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if pagedRows.totalFiltered > TABLE_PAGE_SIZE}
					<div class="flex items-center justify-between px-4 py-3 border-t-2 retro-border-secondary">
						<span class="text-sm retro-text-secondary">
							Showing {(pagedRows.page - 1) * TABLE_PAGE_SIZE + 1}–{Math.min(
								pagedRows.page * TABLE_PAGE_SIZE,
								pagedRows.totalFiltered
							)} of {pagedRows.totalFiltered}
						</span>
						<div class="flex items-center gap-2">
							<button onclick={() => (tablePage = pagedRows.page - 1)} disabled={pagedRows.page <= 1} class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:border-[var(--retro-primary)] disabled:cursor-not-allowed disabled:opacity-50">Prev</button>
							<span class="text-sm retro-text-secondary">Page {pagedRows.page} of {pagedRows.totalPages}</span>
							<button onclick={() => (tablePage = pagedRows.page + 1)} disabled={pagedRows.page >= pagedRows.totalPages} class="rounded-md retro-bg-secondary border border-[var(--retro-light-grey)] px-3 py-1 text-sm retro-text-primary hover:border-[var(--retro-primary)] disabled:cursor-not-allowed disabled:opacity-50">Next</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.spinner {
		display: inline-block;
		width: 0.85rem;
		height: 0.85rem;
		border: 2px solid var(--retro-primary);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
