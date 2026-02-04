<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3Array from 'd3-array';
	import * as d3Scale from 'd3-scale';
	import * as d3Shape from 'd3-shape';
	import type { ModelRankingHistory } from '$lib/types.js';

	// Props
	let {
		rankingHistories = [],
		startRound = 0,
		endRound = 0
	}: {
		rankingHistories: ModelRankingHistory[];
		startRound: number;
		endRound: number;
	} = $props();

	// Chart dimensions
	const margin = { top: 40, right: 120, bottom: 60, left: 70 };
	let containerWidth = $state(800);
	let containerHeight = $state(400);

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

	// Initialize visibility when histories change
	$effect(() => {
		const newVisibility: Record<string, boolean> = {};
		for (const history of rankingHistories) {
			// Preserve existing visibility or default to true
			newVisibility[history.modelId] = modelVisibility[history.modelId] ?? true;
		}
		modelVisibility = newVisibility;
	});

	// Filter visible models
	const visibleHistories = $derived(
		rankingHistories.filter(h => modelVisibility[h.modelId])
	);

	// Calculate data range
	const roundRange = $derived(() => {
		if (visibleHistories.length === 0) return [startRound, endRound];
		const allRounds = visibleHistories.flatMap(h => h.rankings.map(r => r.roundNumber));
		return [
			Math.max(startRound, d3Array.min(allRounds) ?? startRound),
			Math.min(endRound, d3Array.max(allRounds) ?? endRound)
		];
	});

	const maxRank = $derived(() => {
		if (visibleHistories.length === 0) return 100;
		const allRanks = visibleHistories
			.flatMap(h => h.rankings.map(r => r.rank))
			.filter((r): r is number => r !== null);
		return Math.max(d3Array.max(allRanks) ?? 100, 10);
	});

	// Scales
	const xScale = $derived(
		d3Scale.scaleLinear()
			.domain(roundRange())
			.range([0, width])
	);

	const yScale = $derived(
		d3Scale.scaleLinear()
			.domain([1, maxRank()]) // Rank 1 at top
			.range([0, height])
	);

	// Line generator
	const line = $derived(
		d3Shape.line<{ roundNumber: number; rank: number | null }>()
			.defined(d => d.rank !== null)
			.x(d => xScale(d.roundNumber))
			.y(d => yScale(d.rank!))
			.curve(d3Shape.curveMonotoneX)
	);

	// Generate tick values for axes
	const xTicks = $derived(() => {
		const [min, max] = roundRange();
		const range = max - min;
		const step = Math.max(1, Math.ceil(range / 10));
		const ticks: number[] = [];
		for (let i = min; i <= max; i += step) {
			ticks.push(i);
		}
		return ticks;
	});

	const yTicks = $derived(() => {
		const max = maxRank();
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
		score: number | null;
	}>({
		visible: false,
		x: 0,
		y: 0,
		modelName: '',
		round: 0,
		rank: null,
		score: null
	});

	function showTooltip(
		event: MouseEvent,
		history: ModelRankingHistory,
		dataPoint: { roundNumber: number; rank: number | null; customScore: number | null }
	) {
		const rect = (event.currentTarget as Element).getBoundingClientRect();
		tooltip = {
			visible: true,
			x: event.clientX - rect.left + margin.left,
			y: event.clientY - rect.top + margin.top,
			modelName: history.modelName,
			round: dataPoint.roundNumber,
			rank: dataPoint.rank,
			score: dataPoint.customScore
		};
	}

	function hideTooltip() {
		tooltip = { ...tooltip, visible: false };
	}

	// Container element for resize observer
	let chartContainer: HTMLDivElement;

	onMount(() => {
		// Set up resize observer
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
				containerHeight = Math.max(400, entry.contentRect.height);
			}
		});

		if (chartContainer) {
			resizeObserver.observe(chartContainer);
		}

		return () => {
			resizeObserver.disconnect();
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
						{#each yTicks() as tick}
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
						{#each xTicks() as tick}
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
						{#each xTicks() as tick}
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
						{#each yTicks() as tick}
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
							Rank (lower is better)
						</text>
					</g>

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
						{#each history.rankings.filter(r => r.rank !== null) as dataPoint}
							<circle
								cx={xScale(dataPoint.roundNumber)}
								cy={yScale(dataPoint.rank!)}
								r="4"
								fill={getModelColor(rankingHistories.indexOf(history))}
								stroke="var(--retro-bg-dark)"
								stroke-width="1.5"
								class="cursor-pointer hover:r-6 transition-all"
								role="button"
								tabindex="0"
								onmouseenter={(e) => showTooltip(e, history, dataPoint)}
								onmouseleave={hideTooltip}
								onfocus={(e) => showTooltip(e as unknown as MouseEvent, history, dataPoint)}
								onblur={hideTooltip}
							/>
						{/each}
					{/each}
				</g>
			</svg>

			<!-- Tooltip -->
			{#if tooltip.visible}
				<div
					class="absolute pointer-events-none z-10 retro-bg-secondary border-2 border-[var(--retro-primary)] rounded-lg p-3 shadow-lg"
					style="left: {tooltip.x + 10}px; top: {tooltip.y - 10}px; transform: translate(0, -100%);"
				>
					<div class="text-sm font-bold retro-text-primary">{tooltip.modelName}</div>
					<div class="text-xs retro-text-secondary mt-1">Round: {tooltip.round}</div>
					{#if tooltip.rank !== null}
						<div class="text-xs retro-text-accent">Rank: #{tooltip.rank}</div>
					{:else}
						<div class="text-xs retro-text-secondary">Not ranked (no stake)</div>
					{/if}
					{#if tooltip.score !== null}
						<div class="text-xs retro-text-secondary">Score: {tooltip.score.toFixed(4)}</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Chart info -->
		<div class="mt-4 text-xs retro-text-secondary">
			<p>Showing ranks for {visibleHistories.length} of {rankingHistories.length} models</p>
			<p>Round range: {roundRange()[0]} - {roundRange()[1]}</p>
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

	circle:hover {
		r: 6;
	}
</style>
