<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import * as d3Array from 'd3-array';
	import * as d3Scale from 'd3-scale';
	import * as d3Shape from 'd3-shape';
	import type { ModelRankingHistory } from '$lib/types.js';
	import {
		formatPercentile,
		rankDisplayValue,
		type RankingDisplayMode
	} from '$lib/utils/ranking-display.js';
	import {
		isRoundResolving,
		passesResolutionFilter,
		type ResolutionFilter
	} from '$lib/utils/round-resolution.js';
	import { passesStakedFilter, type StakedFilter } from '$lib/utils/round-staked-filter.js';
	import { fieldScopeLabel, type FieldScope } from '$lib/utils/field-scope.js';
	import { invertVisibility, setAllVisible } from '$lib/utils/series-visibility.js';
	import { focusedSeriesColor, toggleFocus } from '$lib/utils/series-focus.js';

	// Props
	let {
		rankingHistories = [],
		startRound = 0,
		endRound = 0,
		displayMode = 'rank',
		metric1Label = 'Corr',
		metric2Label = 'MMC',
		rollingWindow = 1,
		latestResolvedRound = null,
		stakedFilter = 'both',
		stakedFilterEnabled = true,
		onStakedFilterChange,
		onPointSelect
	}: {
		rankingHistories: ModelRankingHistory[];
		startRound: number;
		endRound: number;
		/** 'rank' = raw position (1 best, lower better); 'percentile' = higher better. */
		displayMode?: RankingDisplayMode;
		/** Label for the corr-like metric (Corr for Classic/Crypto, Alpha for Signals). */
		metric1Label?: string;
		/** Label for the mmc-like metric (MMC for Classic/Crypto, MPC for Signals). */
		metric2Label?: string;
		/** Trailing round window the data was computed with (1 = per-round). Used to
		 *  annotate the overlaid metric lines (e.g. "MMC (20r avg)"). */
		rollingWindow?: number;
		/** Latest fully-resolved round; rounds after it are "resolving" (scored but
		 *  not final) and get shaded. null = boundary unknown, treat all as resolved. */
		latestResolvedRound?: number | null;
		/** Staked/Unstaked/Both round filter. The control sits in this panel, beside
		 *  the data it filters, but the value stays with the page so it can be part
		 *  of the shareable URL state. 'both' = unfiltered. */
		stakedFilter?: StakedFilter;
		/** False for Crypto, whose per-round staked flag is unknown: the control is
		 *  shown disabled rather than hidden, so it does not move about per tournament. */
		stakedFilterEnabled?: boolean;
		onStakedFilterChange?: (filter: StakedFilter) => void;
		/** Fired when a data point is clicked, with its round and model name. */
		onPointSelect?: (round: number, modelName: string) => void;
	} = $props();

	// Resolved/resolving filter (chart-owned, mirrors the metric-overlay toggles).
	// 'both' preserves the prior behaviour (all rounds shown, resolving shaded).
	let resolutionFilter = $state<ResolutionFilter>('both');

	// Identifies one plotted series. A model normally has one history; the "vs
	// Both" competitor toggle gives it two (one per fieldScope), which must not
	// collide in the visibility/colour maps keyed below.
	function seriesKey(h: ModelRankingHistory): string {
		return `${h.modelId}:${h.fieldScope ?? 'staked'}`;
	}

	// True when the same model appears under more than one field scope — i.e.
	// the "vs Both" competitor toggle produced two series for it. Used to decide
	// whether the legend/tooltip need to spell out which field a line is.
	const hasDualScope = $derived(
		rankingHistories.some(
			(h, i) => rankingHistories.findIndex((other) => other.modelId === h.modelId) !== i
		)
	);

	const isPercentile = $derived(displayMode === 'percentile');

	// Optional raw-metric overlay lines (corr/mmc on a secondary right axis),
	// toggled by the user. Off by default so the rank line stays the focus.
	let showMetric1 = $state(false);
	let showMetric2 = $state(false);
	const anyMetricOverlay = $derived(showMetric1 || showMetric2);

	// Suffix the metric labels with the rolling window when one is active.
	const metricSuffix = $derived(rollingWindow > 1 ? ` (${rollingWindow}r avg)` : '');

	// Plotted value for a round under the active mode: raw rank, or a 0–100
	// percentile derived from (rank, totalModels). null points are skipped.
	function plotValue(point: { rank: number | null; totalModels: number }): number | null {
		return rankDisplayValue(point.rank, point.totalModels, displayMode);
	}

	// Chart dimensions
	const BASE_HEIGHT = 400;
	let containerWidth = $state(800);
	let viewportHeight = $state(BASE_HEIGHT);
	let screenHeight = $state(BASE_HEIGHT);

	// Full-bleed on small screens: shrink the fixed plot margins so the drawable
	// area fills the (narrow) mobile viewport instead of being lost to axis
	// gutters. The wide right gutter is only needed when the secondary metric
	// axis is overlaid.
	const isNarrow = $derived(containerWidth < 640);
	const margin = $derived({
		top: isNarrow ? 28 : 40,
		right: anyMetricOverlay ? (isNarrow ? 54 : 120) : isNarrow ? 16 : 40,
		bottom: isNarrow ? 48 : 60,
		left: isNarrow ? 46 : 70
	});

	// Cap at the smaller of BASE_HEIGHT, the visible browser viewport, and the
	// device screen so the chart can never extend past what the user can see.
	const containerHeight = $derived(Math.min(BASE_HEIGHT, viewportHeight, screenHeight));

	const width = $derived(Math.max(containerWidth - margin.left - margin.right, 100));
	const height = $derived(Math.max(containerHeight - margin.top - margin.bottom, 100));

	// Color palette for models
	const colors = [
		'#DC143C', // Crimson
		'#00C853', // Green
		'#1E90FF', // Blue
		'#FFD700', // Gold
		'#FF6B35', // Orange
		'#9C27B0', // Purple
		'#00BCD4', // Cyan
		'#FF4081', // Pink
		'#8BC34A', // Light Green
		'#FF5722', // Deep Orange
		'#673AB7', // Deep Purple
		'#009688'  // Teal
	];

	// Model visibility state, keyed by seriesKey (not modelId) so the two lines
	// a "vs Both" model produces can be toggled independently.
	let modelVisibility = $state<Record<string, boolean>>({});
	// The model singled out by clicking one of its points, and what was visible
	// before that — see focusModel.
	let focusedModelId = $state<string | null>(null);
	let visibilityBeforeFocus: Record<string, boolean> | null = null;

	// Initialize visibility when histories change.
	// Depend ONLY on rankingHistories: the read+write of modelVisibility is
	// wrapped in untrack so reassigning it (a new object reference) does not
	// invalidate this effect's own dependency and loop forever
	// (effect_update_depth_exceeded).
	$effect(() => {
		const histories = rankingHistories;
		untrack(() => {
			const newVisibility: Record<string, boolean> = {};
			for (const history of histories) {
				// Preserve existing visibility or default to true
				const key = seriesKey(history);
				newVisibility[key] = modelVisibility[key] ?? true;
			}
			modelVisibility = newVisibility;
		});
	});

	// Filter visible models
	const visibleHistories = $derived(
		rankingHistories.filter(h => modelVisibility[seriesKey(h)])
	);

	// Unique model ids in first-seen order, used to assign each MODEL (not each
	// series) a stable colour — so a model's staked and all-field lines share a
	// colour and are only told apart by dash style.
	const uniqueModelIds = $derived.by(() => {
		const ids: string[] = [];
		for (const h of rankingHistories) {
			if (!ids.includes(h.modelId)) ids.push(h.modelId);
		}
		return ids;
	});

	// Calculate data range
	const roundRange = $derived.by(() => {
		if (visibleHistories.length === 0) return [startRound, endRound];
		const allRounds = visibleHistories.flatMap(h => h.rankings.map(r => r.roundNumber));
		return [
			Math.max(startRound, d3Array.min(allRounds) ?? startRound),
			Math.min(endRound, d3Array.max(allRounds) ?? endRound)
		];
	});

	const maxRank = $derived.by(() => {
		if (visibleHistories.length === 0) return 100;
		const allRanks = visibleHistories
			.flatMap(h => h.rankings.map(r => r.rank))
			.filter((r): r is number => r !== null);
		return Math.max(d3Array.max(allRanks) ?? 100, 10);
	});

	// Scales
	const xScale = $derived(
		d3Scale.scaleLinear()
			.domain(roundRange)
			.range([0, width])
	);

	// Percentile mode: 0 at the bottom, 100 (best) at the top — higher is better.
	// Rank mode: rank 1 at the top, larger (worse) ranks lower — lower is better.
	const yScale = $derived(
		isPercentile
			? d3Scale.scaleLinear().domain([0, 100]).range([height, 0])
			: d3Scale.scaleLinear().domain([1, maxRank]).range([0, height])
	);

	// Line generator. Plots rank or percentile depending on mode; points whose
	// plotted value is null (unranked / empty field) are skipped.
	const line = $derived(
		d3Shape.line<{ roundNumber: number; rank: number | null; totalModels: number }>()
			.defined(d => plotValue(d) !== null)
			.x(d => xScale(d.roundNumber))
			.y(d => yScale(plotValue(d)!))
			.curve(d3Shape.curveMonotoneX)
	);

	// ── Resolved vs resolving, and staked vs unstaked ──────────────────────────
	// Filter each model's rounds ONCE per (filter, boundary, data) change, keyed
	// by seriesKey, rather than re-filtering in the template for every
	// line/point/overlay pass. Iterating visibleHistories (not copies) keeps
	// object identity so the per-model colour lookup still works.
	const displayedRankingsById = $derived.by(() => {
		const byId = new Map<string, ModelRankingHistory['rankings']>();
		for (const h of visibleHistories) {
			byId.set(
				seriesKey(h),
				h.rankings.filter(
					(r) =>
						passesResolutionFilter(r.roundNumber, latestResolvedRound, resolutionFilter) &&
						passesStakedFilter(r.staked, stakedFilter)
				)
			);
		}
		return byId;
	});

	// Whether any resolving round is on screen. Derived from the (clamped) visible
	// domain so the toggle and the shaded band never disagree, and Classic — which
	// stores resolved-only rounds — keeps the control hidden.
	const resolvingOnScreen = $derived(isRoundResolving(roundRange[1], latestResolvedRound));
	const showResolutionControls = $derived(resolvingOnScreen);

	// x-region [latestResolvedRound, end] to shade, or null when nothing resolving
	// is on screen (boundary unknown, filtered to resolved-only, or all resolved).
	const resolvingBand = $derived.by((): { x: number; width: number } | null => {
		if (latestResolvedRound === null || !resolvingOnScreen || resolutionFilter === 'resolved') return null;
		const startX = Math.max(0, Math.min(width, xScale(latestResolvedRound + 0.5)));
		const bandWidth = width - startX;
		return bandWidth > 0 ? { x: startX, width: bandWidth } : null;
	});

	// ── Raw-metric overlay (secondary right axis) ───────────────────────────────
	// Domain spans the enabled metrics across visible models, padded 10%. null
	// when no overlay is active or there are no values to plot.
	type MetricKey = 'corr' | 'mmc';
	const metricExtent = $derived.by((): [number, number] | null => {
		if (!anyMetricOverlay) return null;
		const vals: number[] = [];
		for (const h of visibleHistories) {
			for (const r of h.rankings) {
				if (showMetric1 && r.corr !== null) vals.push(r.corr);
				if (showMetric2 && r.mmc !== null) vals.push(r.mmc);
			}
		}
		if (vals.length === 0) return null;
		const min = d3Array.min(vals)!;
		const max = d3Array.max(vals)!;
		if (min === max) return [min - 0.01, max + 0.01];
		const pad = (max - min) * 0.1;
		return [min - pad, max + pad];
	});

	// Right-axis scale for metric values (higher value = higher on the chart).
	const yScaleMetric = $derived(
		d3Scale.scaleLinear()
			.domain(metricExtent ?? [0, 1])
			.range([height, 0])
	);

	const metricTicks = $derived(metricExtent ? yScaleMetric.ticks(5) : []);

	// Line generator for a given metric; skips null points.
	function metricLineFor(key: MetricKey) {
		return d3Shape.line<{ roundNumber: number; corr: number | null; mmc: number | null }>()
			.defined(d => d[key] !== null)
			.x(d => xScale(d.roundNumber))
			.y(d => yScaleMetric(d[key]!))
			.curve(d3Shape.curveMonotoneX);
	}
	const corrLine = $derived(metricLineFor('corr'));
	const mmcLine = $derived(metricLineFor('mmc'));

	// Generate tick values for axes
	const xTicks = $derived.by(() => {
		const [min, max] = roundRange;
		const range = max - min;
		const step = Math.max(1, Math.ceil(range / 10));
		const ticks: number[] = [];
		for (let i = min; i <= max; i += step) {
			ticks.push(i);
		}
		return ticks;
	});

	const yTicks = $derived.by(() => {
		if (isPercentile) return [0, 25, 50, 75, 100];
		const max = maxRank;
		const step = Math.max(1, Math.ceil(max / 10));
		const ticks: number[] = [];
		for (let i = 1; i <= max; i += step) {
			ticks.push(i);
		}
		return ticks;
	});

	// Colour by MODEL (not series), so a model's staked/all-field lines match.
	// Under a focus, every other model is greyed — see focusModel.
	function getModelColor(modelId: string): string {
		const index = uniqueModelIds.indexOf(modelId);
		const color = colors[(index < 0 ? 0 : index) % colors.length];
		return focusedSeriesColor(color, modelId, focusedModelId);
	}

	/**
	 * Clicking a point singles that model out and clicking it again puts the
	 * chart back, remembering what was visible on the way in. Same behaviour as
	 * the performance chart, so the two read the same way.
	 */
	function focusModel(modelId: string) {
		const next = toggleFocus(focusedModelId, modelId);
		if (next === null) {
			if (visibilityBeforeFocus) modelVisibility = { ...visibilityBeforeFocus };
			visibilityBeforeFocus = null;
		} else if (focusedModelId === null) {
			visibilityBeforeFocus = { ...modelVisibility };
		}
		focusedModelId = next;
	}

	// Dash pattern by field scope: solid for the staked field (or single-scope
	// mode), dashed for "all models" — the same convention as the metric overlay
	// legend ("dashed"/"dotted") uses for its own lines.
	function lineDashArray(h: ModelRankingHistory): string {
		return (h.fieldScope ?? 'staked') === 'all' ? '7,4' : 'none';
	}

	/** Every plotted series, in legend order — what the bulk controls act on. */
	const seriesKeys = $derived(rankingHistories.map(seriesKey));

	const showAll = () => (modelVisibility = setAllVisible(seriesKeys, true));
	const hideAll = () => (modelVisibility = setAllVisible(seriesKeys, false));
	const invertAll = () => (modelVisibility = invertVisibility(seriesKeys, modelVisibility));
	const shownCount = $derived(seriesKeys.filter((key) => modelVisibility[key] ?? true).length);

	// Toggle one series' visibility (keyed by seriesKey, not modelId — see above).
	function toggleModelVisibility(key: string) {
		modelVisibility = {
			...modelVisibility,
			[key]: !modelVisibility[key]
		};
	}

	// Tooltip state
	let tooltip = $state<{
		visible: boolean;
		x: number;
		y: number;
		modelName: string;
		fieldScope: FieldScope;
		round: number;
		rank: number | null;
		totalModels: number;
		score: number | null;
		corr: number | null;
		mmc: number | null;
		resolving: boolean;
	}>({
		visible: false,
		x: 0,
		y: 0,
		modelName: '',
		fieldScope: 'staked',
		round: 0,
		rank: null,
		totalModels: 0,
		score: null,
		corr: null,
		mmc: null,
		resolving: false
	});

	// Position the tooltip from the hovered/focused circle's own geometry. cx/cy
	// live in the inner <g> space (offset by margin), which matches the absolutely
	// positioned tooltip's coordinate space — so the tooltip lands next to the
	// point. (The old version derived x/y from the mouse offset *within* the tiny
	// circle, which always collapsed to ~the top-left margin corner.) Both mouse
	// and keyboard handlers share this since event.currentTarget is the circle.
	function setTooltipFromCircle(
		circle: SVGCircleElement,
		history: ModelRankingHistory,
		dataPoint: {
			roundNumber: number;
			rank: number | null;
			totalModels: number;
			customScore: number | null;
			corr: number | null;
			mmc: number | null;
		}
	) {
		tooltip = {
			visible: true,
			x: parseFloat(circle.getAttribute('cx') ?? '0') + margin.left,
			y: parseFloat(circle.getAttribute('cy') ?? '0') + margin.top,
			modelName: history.modelName,
			fieldScope: history.fieldScope ?? 'staked',
			round: dataPoint.roundNumber,
			rank: dataPoint.rank,
			totalModels: dataPoint.totalModels,
			score: dataPoint.customScore,
			corr: dataPoint.corr,
			mmc: dataPoint.mmc,
			resolving: isRoundResolving(dataPoint.roundNumber, latestResolvedRound)
		};
	}

	function hideTooltip() {
		tooltip = { ...tooltip, visible: false };
	}

	// Container element for resize observer
	let chartContainer: HTMLDivElement;

	onMount(() => {
		viewportHeight = window.innerHeight;
		screenHeight = window.screen?.height ?? window.innerHeight;

		// Only observe width. Reading contentRect.height back into containerHeight
		// would feed back into the SVG height (the SVG IS the container's tallest
		// child), growing the chart unboundedly each tick.
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
			}
		});

		const onWindowResize = () => {
			viewportHeight = window.innerHeight;
		};
		window.addEventListener('resize', onWindowResize);

		if (chartContainer) {
			resizeObserver.observe(chartContainer);
		}

		return () => {
			resizeObserver.disconnect();
			window.removeEventListener('resize', onWindowResize);
		};
	});
</script>

<div class="rankings-chart-container" bind:this={chartContainer}>
	{#if rankingHistories.length === 0}
		<div class="flex items-center justify-center h-64 retro-bg-secondary rounded-lg">
			<p class="retro-text-secondary">Select models and load rankings to display the chart</p>
		</div>
	{:else}
		<!-- Chart controls: what the chart plots (round filter) and which of its
		     series are visible. Both sit here, beside the chart they act on, rather
		     than with the query controls that decide what is fetched. -->
		<div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
			<div
				class="flex items-center gap-2"
				class:opacity-50={!stakedFilterEnabled}
				title={stakedFilterEnabled
					? undefined
					: "Crypto's staked flag reflects the model's current stake, not a per-round fact, so this filter has nothing to act on."}
			>
				<span class="text-xs font-medium retro-text-secondary uppercase">Rounds</span>
				<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
					{#each [{ v: 'staked', label: 'Staked' }, { v: 'unstaked', label: 'Unstaked' }, { v: 'both', label: 'Both' }] as opt}
						<button
							onclick={() => onStakedFilterChange?.(opt.v as StakedFilter)}
							disabled={!stakedFilterEnabled}
							class="px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed"
							style={stakedFilter === opt.v
								? 'background-color: var(--retro-primary); color: white;'
								: 'color: var(--retro-text-primary);'}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium retro-text-secondary uppercase">
					Models ({shownCount}/{seriesKeys.length})
				</span>
				<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
					{#each [{ label: 'All', run: showAll }, { label: 'None', run: hideAll }, { label: 'Invert', run: invertAll }] as action}
						<button
							onclick={action.run}
							class="px-2.5 py-1 text-xs font-medium transition-colors"
							style="color: var(--retro-text-primary);"
						>
							{action.label}
						</button>
					{/each}
				</div>
			</div>
		</div>

		<!-- Model Legend/Toggles. Each history is its own toggle — when the "vs Both"
		     competitor toggle is active a model has two (staked + all), shown here
		     as separate chips sharing a colour but naming their field. -->
		<div class="mb-4 flex flex-wrap gap-2">
			{#each rankingHistories as history (seriesKey(history))}
				{@const color = getModelColor(history.modelId)}
				{@const key = seriesKey(history)}
				<button
					onclick={() => toggleModelVisibility(key)}
					class="flex items-center gap-2 px-3 py-1 rounded-full text-sm transition-all {modelVisibility[key] ? 'opacity-100' : 'opacity-40'}"
					style="background-color: {color}20; border: 2px solid {color};"
				>
					<span
						class="w-3 h-3 rounded-full"
						style="background-color: {color};"
					></span>
					<span class="retro-text-primary">
						{history.modelName}{hasDualScope ? ` (${fieldScopeLabel(history.fieldScope ?? 'staked')})` : ''}
					</span>
				</button>
			{/each}
		</div>
		{#if hasDualScope}
			<p class="mb-4 text-xs retro-text-secondary">
				Solid line = staked field, dashed line = all models (vs Both competitor toggle).
			</p>
		{/if}

		<!-- Raw-metric overlay toggles. Overlay the per-round (or windowed) metric
		     values on a secondary right axis, alongside the rank line. -->
		<div class="mb-4 flex flex-wrap items-center gap-4">
			<span class="text-sm font-medium retro-text-secondary">Overlay metric lines:</span>
			<label class="flex items-center gap-2 text-sm retro-text-primary cursor-pointer">
				<input type="checkbox" bind:checked={showMetric1} class="accent-[var(--retro-primary)]" />
				{metric1Label}{metricSuffix} <span class="retro-text-secondary">(dashed)</span>
			</label>
			<label class="flex items-center gap-2 text-sm retro-text-primary cursor-pointer">
				<input type="checkbox" bind:checked={showMetric2} class="accent-[var(--retro-primary)]" />
				{metric2Label}{metricSuffix} <span class="retro-text-secondary">(dotted)</span>
			</label>
			{#if anyMetricOverlay}
				<span class="text-xs retro-text-secondary">Values use the right axis; colour matches each model.</span>
			{/if}
		</div>

		<!-- Resolved / resolving toggle. Only shown when the data spans rounds that
		     aren't final yet; those rounds are shaded so they read as provisional. -->
		{#if showResolutionControls}
			<div class="mb-4 flex flex-wrap items-center gap-3">
				<span class="text-sm font-medium retro-text-secondary">Rounds:</span>
				<div class="inline-flex overflow-hidden rounded-md border-2 border-[var(--retro-primary)]">
					{#each [{ v: 'both', label: 'Both' }, { v: 'resolved', label: 'Resolved' }, { v: 'resolving', label: 'Resolving' }] as opt}
						<button
							onclick={() => (resolutionFilter = opt.v as ResolutionFilter)}
							class="px-3 py-1 text-sm font-medium transition-colors"
							style={resolutionFilter === opt.v
								? 'background-color: var(--retro-primary); color: white;'
								: 'color: var(--retro-text-primary);'}
						>
							{opt.label}
						</button>
					{/each}
				</div>
				<span class="text-xs retro-text-secondary">Shaded region = resolving (scores not final yet).</span>
			</div>
		{/if}

		<!-- SVG Chart -->
		<div class="relative">
			<svg
				width={containerWidth}
				height={containerHeight}
				class="rankings-chart"
				role="img"
				aria-label="Model rankings over time"
			>
				<g transform="translate({margin.left}, {margin.top})">
					<!-- Resolving-rounds shading (drawn first, behind everything) -->
					{#if resolvingBand}
						<rect
							x={resolvingBand.x}
							y="0"
							width={resolvingBand.width}
							height={height}
							fill="var(--retro-light-grey)"
							opacity="0.18"
						/>
						<text
							x={resolvingBand.x + 4}
							y="12"
							fill="var(--retro-text-dim)"
							font-size="10"
							font-style="italic"
						>
							resolving
						</text>
					{/if}

					<!-- Grid lines -->
					<g class="grid-lines">
						<!-- Horizontal grid lines -->
						{#each yTicks as tick}
							<line
								x1="0"
								y1={yScale(tick)}
								x2={width}
								y2={yScale(tick)}
								stroke="var(--retro-light-grey)"
								stroke-opacity="0.3"
								stroke-dasharray="4,4"
							/>
						{/each}
						<!-- Vertical grid lines -->
						{#each xTicks as tick}
							<line
								x1={xScale(tick)}
								y1="0"
								x2={xScale(tick)}
								y2={height}
								stroke="var(--retro-light-grey)"
								stroke-opacity="0.3"
								stroke-dasharray="4,4"
							/>
						{/each}
					</g>

					<!-- X Axis -->
					<g class="x-axis" transform="translate(0, {height})">
						<line x1="0" y1="0" x2={width} y2="0" stroke="var(--retro-text-dim)" />
						{#each xTicks as tick}
							<g transform="translate({xScale(tick)}, 0)">
								<line y1="0" y2="6" stroke="var(--retro-text-dim)" />
								<text
									y="20"
									text-anchor="middle"
									fill="var(--retro-text-dim)"
									font-size="12"
								>
									{tick}
								</text>
							</g>
						{/each}
						<text
							x={width / 2}
							y="45"
							text-anchor="middle"
							fill="var(--retro-text)"
							font-size="14"
							font-weight="bold"
						>
							Round Number
						</text>
					</g>

					<!-- Y Axis -->
					<g class="y-axis">
						<line x1="0" y1="0" x2="0" y2={height} stroke="var(--retro-text-dim)" />
						{#each yTicks as tick}
							<g transform="translate(0, {yScale(tick)})">
								<line x1="-6" x2="0" stroke="var(--retro-text-dim)" />
								<text
									x="-12"
									dy="0.35em"
									text-anchor="end"
									fill="var(--retro-text-dim)"
									font-size="12"
								>
									{tick}
								</text>
							</g>
						{/each}
						{#if !isNarrow}
							<text
								transform="rotate(-90)"
								x={-height / 2}
								y="-50"
								text-anchor="middle"
								fill="var(--retro-text)"
								font-size="14"
								font-weight="bold"
							>
								{isPercentile ? 'Percentile (higher is better)' : 'Rank (lower is better)'}
							</text>
						{/if}
					</g>

					<!-- Right (secondary) Axis: raw metric values when an overlay is on -->
					{#if metricExtent}
						<g class="y-axis-right" transform="translate({width}, 0)">
							<line x1="0" y1="0" x2="0" y2={height} stroke="var(--retro-text-dim)" />
							{#each metricTicks as tick}
								<g transform="translate(0, {yScaleMetric(tick)})">
									<line x1="0" x2="6" stroke="var(--retro-text-dim)" />
									<text
										x="12"
										dy="0.35em"
										text-anchor="start"
										fill="var(--retro-text-dim)"
										font-size="12"
									>
										{tick.toFixed(3)}
									</text>
								</g>
							{/each}
							{#if !isNarrow}
								<text
									transform="rotate(-90)"
									x={-height / 2}
									y="56"
									text-anchor="middle"
									fill="var(--retro-text)"
									font-size="14"
									font-weight="bold"
								>
									{[showMetric1 ? metric1Label : null, showMetric2 ? metric2Label : null]
										.filter(Boolean)
										.join(' / ')}{metricSuffix}
								</text>
							{/if}
						</g>
					{/if}

					<!-- Metric overlay lines (drawn under the rank line/points so the rank
					     stays the focal series). Dashed = metric1 (corr), dotted = metric2. -->
					{#if anyMetricOverlay}
						{#each visibleHistories as history (seriesKey(history))}
							{@const color = getModelColor(history.modelId)}
							{@const rankings = displayedRankingsById.get(seriesKey(history)) ?? history.rankings}
							{#if showMetric1}
								{@const corrPath = corrLine(rankings)}
								{#if corrPath}
									<path
										d={corrPath}
										fill="none"
										stroke={color}
										stroke-width="1.5"
										stroke-dasharray="6,4"
										stroke-opacity="0.7"
									/>
								{/if}
							{/if}
							{#if showMetric2}
								{@const mmcPath = mmcLine(rankings)}
								{#if mmcPath}
									<path
										d={mmcPath}
										fill="none"
										stroke={color}
										stroke-width="1.5"
										stroke-dasharray="2,3"
										stroke-opacity="0.7"
									/>
								{/if}
							{/if}
						{/each}
					{/if}

					<!-- Data lines. Solid = staked field (or single-scope mode); dashed = all
					     models — see lineDashArray. A model's two "vs Both" lines share a
					     colour (getModelColor keys off modelId, not the series). -->
					{#each visibleHistories as history (seriesKey(history))}
						{@const rankings = displayedRankingsById.get(seriesKey(history)) ?? history.rankings}
						{@const pathData = line(rankings)}
						{#if pathData}
							<path
								d={pathData}
								fill="none"
								stroke={getModelColor(history.modelId)}
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-dasharray={lineDashArray(history)}
							/>
						{/if}

						<!-- Data points -->
						{#each rankings.filter(r => plotValue(r) !== null) as dataPoint}
							{@const resolving = isRoundResolving(dataPoint.roundNumber, latestResolvedRound)}
							<circle
								cx={xScale(dataPoint.roundNumber)}
								cy={yScale(plotValue(dataPoint)!)}
								r="4"
								fill={getModelColor(history.modelId)}
								fill-opacity={resolving ? 0.4 : 1}
								stroke="var(--retro-bg-dark)"
								stroke-width="1.5"
								class="cursor-pointer hover:r-6 transition-all"
								role="button"
								tabindex="0"
								aria-label={isPercentile
									? `Round ${dataPoint.roundNumber}, ${history.modelName}, percentile ${formatPercentile(plotValue(dataPoint)!)}`
									: `Round ${dataPoint.roundNumber}, ${history.modelName}, rank ${dataPoint.rank} of ${dataPoint.totalModels} (${fieldScopeLabel(history.fieldScope ?? 'staked')})`}
								onmouseenter={(e) => setTooltipFromCircle(e.currentTarget, history, dataPoint)}
								onmouseleave={hideTooltip}
								onfocus={(e) => setTooltipFromCircle(e.currentTarget, history, dataPoint)}
								onblur={hideTooltip}
								onclick={() => {
									focusModel(history.modelId);
									onPointSelect?.(dataPoint.roundNumber, history.modelName);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										focusModel(history.modelId);
										onPointSelect?.(dataPoint.roundNumber, history.modelName);
									}
								}}
							/>
						{/each}
					{/each}
				</g>
			</svg>

			<!-- Tooltip -->
			{#if tooltip.visible}
				<div
					class="rankings-tooltip absolute pointer-events-none z-10 retro-bg-secondary border-2 border-[var(--retro-primary)] rounded-lg p-3 shadow-lg"
					style="left: {tooltip.x + 10}px; top: {tooltip.y - 10}px; transform: translate(0, -100%);"
				>
					<div class="text-sm font-bold">{tooltip.modelName}</div>
					<div class="text-xs mt-1">
						Round: {tooltip.round}
						{#if tooltip.resolving}
							<span class="text-yellow-400">(resolving)</span>
						{/if}
					</div>
					{#if tooltip.rank !== null}
						{#if isPercentile}
							<div class="text-xs">
								Percentile: {formatPercentile(rankDisplayValue(tooltip.rank, tooltip.totalModels, 'percentile')!)}
							</div>
						{:else}
							<div class="text-xs">Rank: #{tooltip.rank}</div>
						{/if}
						<!-- totalModels differs between the staked field and all models, so the
						     denominator's source must always be spelled out — never left implicit. -->
						<div class="text-xs">
							Out of {tooltip.totalModels} ({fieldScopeLabel(tooltip.fieldScope)})
						</div>
					{:else}
						<div class="text-xs">Not ranked (no stake)</div>
					{/if}
					{#if tooltip.corr !== null}
						<div class="text-xs">{metric1Label}{metricSuffix}: {tooltip.corr.toFixed(4)}</div>
					{/if}
					{#if tooltip.mmc !== null}
						<div class="text-xs">{metric2Label}{metricSuffix}: {tooltip.mmc.toFixed(4)}</div>
					{/if}
					{#if tooltip.score !== null}
						<div class="text-xs">Score: {tooltip.score.toFixed(4)}</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Chart info -->
		<div class="mt-4 text-xs retro-text-secondary">
			<p>Showing ranks for {visibleHistories.length} of {rankingHistories.length} {hasDualScope ? 'series (staked + all-models lines)' : 'models'}</p>
			<p>Round range: {roundRange[0]} - {roundRange[1]}</p>
		</div>
	{/if}
</div>

<style>
	.rankings-chart-container {
		width: 100%;
		min-height: 400px;
	}

	.rankings-chart {
		display: block;
	}

	/* All tooltip text white for readability against the dark tooltip background. */
	.rankings-tooltip,
	.rankings-tooltip :global(*) {
		color: #ffffff;
	}

	circle:hover {
		r: 6;
	}
</style>
