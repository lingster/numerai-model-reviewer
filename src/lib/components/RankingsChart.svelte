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

	// Props
	let {
		rankingHistories = [],
		startRound = 0,
		endRound = 0,
		displayMode = 'rank',
		metric1Label = 'Corr',
		metric2Label = 'MMC',
		rollingWindow = 1,
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
		/** Fired when a data point is clicked, with its round and model name. */
		onPointSelect?: (round: number, modelName: string) => void;
	} = $props();

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
	const margin = { top: 40, right: 120, bottom: 60, left: 70 };
	const BASE_HEIGHT = 400;
	let containerWidth = $state(800);
	let viewportHeight = $state(BASE_HEIGHT);
	let screenHeight = $state(BASE_HEIGHT);

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

	// Model visibility state
	let modelVisibility = $state<Record<string, boolean>>({});

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
				newVisibility[history.modelId] = modelVisibility[history.modelId] ?? true;
			}
			modelVisibility = newVisibility;
		});
	});

	// Filter visible models
	const visibleHistories = $derived(
		rankingHistories.filter(h => modelVisibility[h.modelId])
	);

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

	// Get color for model
	function getModelColor(index: number): string {
		return colors[index % colors.length];
	}

	// Toggle model visibility
	function toggleModelVisibility(modelId: string) {
		modelVisibility = {
			...modelVisibility,
			[modelId]: !modelVisibility[modelId]
		};
	}

	// Tooltip state
	let tooltip = $state<{
		visible: boolean;
		x: number;
		y: number;
		modelName: string;
		round: number;
		rank: number | null;
		totalModels: number;
		score: number | null;
		corr: number | null;
		mmc: number | null;
	}>({
		visible: false,
		x: 0,
		y: 0,
		modelName: '',
		round: 0,
		rank: null,
		totalModels: 0,
		score: null,
		corr: null,
		mmc: null
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
			round: dataPoint.roundNumber,
			rank: dataPoint.rank,
			totalModels: dataPoint.totalModels,
			score: dataPoint.customScore,
			corr: dataPoint.corr,
			mmc: dataPoint.mmc
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
		<!-- Model Legend/Toggles -->
		<div class="mb-4 flex flex-wrap gap-2">
			{#each rankingHistories as history, index}
				<button
					onclick={() => toggleModelVisibility(history.modelId)}
					class="flex items-center gap-2 px-3 py-1 rounded-full text-sm transition-all {modelVisibility[history.modelId] ? 'opacity-100' : 'opacity-40'}"
					style="background-color: {getModelColor(index)}20; border: 2px solid {getModelColor(index)};"
				>
					<span
						class="w-3 h-3 rounded-full"
						style="background-color: {getModelColor(index)};"
					></span>
					<span class="retro-text-primary">{history.modelName}</span>
				</button>
			{/each}
		</div>

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
						</g>
					{/if}

					<!-- Metric overlay lines (drawn under the rank line/points so the rank
					     stays the focal series). Dashed = metric1 (corr), dotted = metric2. -->
					{#if anyMetricOverlay}
						{#each visibleHistories as history}
							{@const color = getModelColor(rankingHistories.indexOf(history))}
							{#if showMetric1}
								{@const corrPath = corrLine(history.rankings)}
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
								{@const mmcPath = mmcLine(history.rankings)}
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

					<!-- Data lines -->
					{#each visibleHistories as history, index}
						{@const pathData = line(history.rankings)}
						{#if pathData}
							<path
								d={pathData}
								fill="none"
								stroke={getModelColor(rankingHistories.indexOf(history))}
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						{/if}

						<!-- Data points -->
						{#each history.rankings.filter(r => plotValue(r) !== null) as dataPoint}
							<circle
								cx={xScale(dataPoint.roundNumber)}
								cy={yScale(plotValue(dataPoint)!)}
								r="4"
								fill={getModelColor(rankingHistories.indexOf(history))}
								stroke="var(--retro-bg-dark)"
								stroke-width="1.5"
								class="cursor-pointer hover:r-6 transition-all"
								role="button"
								tabindex="0"
								aria-label={isPercentile
									? `Round ${dataPoint.roundNumber}, ${history.modelName}, percentile ${formatPercentile(plotValue(dataPoint)!)}`
									: `Round ${dataPoint.roundNumber}, ${history.modelName}, rank ${dataPoint.rank}`}
								onmouseenter={(e) => setTooltipFromCircle(e.currentTarget, history, dataPoint)}
								onmouseleave={hideTooltip}
								onfocus={(e) => setTooltipFromCircle(e.currentTarget, history, dataPoint)}
								onblur={hideTooltip}
								onclick={() => onPointSelect?.(dataPoint.roundNumber, history.modelName)}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
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
					<div class="text-xs mt-1">Round: {tooltip.round}</div>
					{#if tooltip.rank !== null}
						{#if isPercentile}
							<div class="text-xs">
								Percentile: {formatPercentile(rankDisplayValue(tooltip.rank, tooltip.totalModels, 'percentile')!)}
							</div>
						{:else}
							<div class="text-xs">Rank: #{tooltip.rank}</div>
						{/if}
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
			<p>Showing ranks for {visibleHistories.length} of {rankingHistories.length} models</p>
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
