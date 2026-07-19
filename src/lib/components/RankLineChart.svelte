<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3Array from 'd3-array';
	import * as d3Scale from 'd3-scale';
	import * as d3Shape from 'd3-shape';

	interface SeriesDataPoint {
		roundNumber: number;
		rank: number | null;
		customScore: number | null;
	}

	interface ChartSeries {
		id: string;
		name: string;
		color: string;
		visible: boolean;
		rankings: SeriesDataPoint[];
	}

	let {
		series = [],
		startRound = 0,
		endRound = 0
	}: {
		series: ChartSeries[];
		startRound: number;
		endRound: number;
	} = $props();

	const CHART_HEIGHT = 400;
	let containerWidth = $state(800);

	// Tighter side/top gutters on narrow (mobile) viewports so the plot uses the
	// full available width instead of losing it to fixed axis margins.
	const isNarrow = $derived(containerWidth < 640);
	const margin = $derived({
		top: isNarrow ? 28 : 40,
		right: isNarrow ? 16 : 40,
		bottom: isNarrow ? 48 : 60,
		left: isNarrow ? 46 : 70
	});

	const width = $derived(Math.max(containerWidth - margin.left - margin.right, 100));
	const height = $derived(CHART_HEIGHT - margin.top - margin.bottom);

	const visibleSeries = $derived(series.filter(s => s.visible));

	const roundRange = $derived.by(() => {
		if (visibleSeries.length === 0) return [startRound, endRound];
		const allRounds = visibleSeries.flatMap(s => s.rankings.map(r => r.roundNumber));
		return [
			Math.max(startRound, d3Array.min(allRounds) ?? startRound),
			Math.min(endRound, d3Array.max(allRounds) ?? endRound)
		];
	});

	const maxRank = $derived.by(() => {
		if (visibleSeries.length === 0) return 100;
		const allRanks = visibleSeries
			.flatMap(s => s.rankings.map(r => r.rank))
			.filter((r): r is number => r !== null);
		return Math.max(d3Array.max(allRanks) ?? 100, 10);
	});

	const xScale = $derived(
		d3Scale.scaleLinear()
			.domain(roundRange)
			.range([0, width])
	);

	const yScale = $derived(
		d3Scale.scaleLinear()
			.domain([1, maxRank])
			.range([0, height])
	);

	const line = $derived(
		d3Shape.line<SeriesDataPoint>()
			.defined(d => d.rank !== null)
			.x(d => xScale(d.roundNumber))
			.y(d => yScale(d.rank!))
			.curve(d3Shape.curveMonotoneX)
	);

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
		const max = maxRank;
		const step = Math.max(1, Math.ceil(max / 10));
		const ticks: number[] = [];
		for (let i = 1; i <= max; i += step) {
			ticks.push(i);
		}
		return ticks;
	});

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
		s: ChartSeries,
		dataPoint: SeriesDataPoint
	) {
		const rect = (event.currentTarget as Element).getBoundingClientRect();
		tooltip = {
			visible: true,
			x: event.clientX - rect.left + margin.left,
			y: event.clientY - rect.top + margin.top,
			modelName: s.name,
			round: dataPoint.roundNumber,
			rank: dataPoint.rank,
			score: dataPoint.customScore
		};
	}

	function hideTooltip() {
		tooltip = { ...tooltip, visible: false };
	}

	let chartContainer: HTMLDivElement;

	onMount(() => {
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
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

<div class="rank-line-chart-container" bind:this={chartContainer}>
	{#if series.length === 0}
		<div class="flex items-center justify-center h-64 retro-bg-secondary rounded-lg">
			<p class="retro-text-secondary">No ranking data to display</p>
		</div>
	{:else}
		<div class="relative">
			<svg
				width={containerWidth}
				height={CHART_HEIGHT}
				class="rank-line-chart"
				role="img"
				aria-label="Model rankings over time"
			>
				<g transform="translate({margin.left}, {margin.top})">
					<!-- Grid lines -->
					<g class="grid-lines">
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
								Rank (lower is better)
							</text>
						{/if}
					</g>

					<!-- Data lines -->
					{#each visibleSeries as s}
						{@const pathData = line(s.rankings)}
						{#if pathData}
							<path
								d={pathData}
								fill="none"
								stroke={s.color}
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						{/if}

						{#each s.rankings.filter(r => r.rank !== null) as dataPoint}
							<circle
								cx={xScale(dataPoint.roundNumber)}
								cy={yScale(dataPoint.rank!)}
								r="4"
								fill={s.color}
								stroke="var(--retro-bg-dark)"
								stroke-width="1.5"
								class="cursor-pointer hover:r-6 transition-all"
								role="button"
								tabindex="0"
								onmouseenter={(e) => showTooltip(e, s, dataPoint)}
								onmouseleave={hideTooltip}
								onfocus={(e) => showTooltip(e as unknown as MouseEvent, s, dataPoint)}
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

		<div class="mt-4 text-xs retro-text-secondary">
			<p>Showing {visibleSeries.length} of {series.length} series</p>
			<p>Round range: {roundRange[0]} - {roundRange[1]}</p>
		</div>
	{/if}
</div>

<style>
	.rank-line-chart-container {
		width: 100%;
	}

	.rank-line-chart {
		display: block;
	}

	circle:hover {
		r: 6;
	}
</style>
