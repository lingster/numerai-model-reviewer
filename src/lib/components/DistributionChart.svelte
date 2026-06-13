<script lang="ts">
	import * as d3Scale from 'd3-scale';
	import type { DistributionBin, DistributionModelEntry } from '$lib/types.js';

	// Props
	let {
		bins = [],
		myModels = [],
		scoreLabel = 'Score'
	}: {
		bins: DistributionBin[];
		myModels: DistributionModelEntry[];
		/** X-axis label, e.g. "Score (0.75×Corr + 2.25×MMC)". */
		scoreLabel?: string;
	} = $props();

	// Chart dimensions
	const margin = { top: 28, right: 24, bottom: 56, left: 64 };
	const HEIGHT = 380;
	let containerWidth = $state(800);
	const width = $derived(Math.max(containerWidth - margin.left - margin.right, 100));
	const height = HEIGHT - margin.top - margin.bottom;

	// Colours: unstaked models are part of the grey "all" bar; staked models are
	// the theme-primary overlay; the user's own models are gold diamonds so they
	// stand out against both.
	const COLOR_ALL = '#8A8A8A';
	const COLOR_STAKED = 'var(--retro-primary)';
	const COLOR_MINE = '#FFD700';

	const xDomain = $derived.by((): [number, number] => {
		if (bins.length === 0) return [0, 1];
		return [bins[0].x0, bins[bins.length - 1].x1];
	});

	const xScale = $derived(d3Scale.scaleLinear().domain(xDomain).range([0, width]));
	const yMax = $derived(Math.max(1, ...bins.map((b) => b.allCount)));
	const yScale = $derived(d3Scale.scaleLinear().domain([0, yMax]).range([height, 0]));

	const xTicks = $derived(xScale.ticks(8));
	const yTicks = $derived(yScale.ticks(6).filter((t) => Number.isInteger(t)));

	function formatScore(v: number): string {
		if (v === 0) return '0';
		return v.toLocaleString(undefined, { maximumSignificantDigits: 3 });
	}

	/** Index of the bin containing a score (clamped to the last bin). */
	function binIndexFor(score: number): number {
		if (bins.length === 0) return -1;
		const idx = bins.findIndex((b, i) => score >= b.x0 && (score < b.x1 || i === bins.length - 1));
		return idx < 0 ? bins.length - 1 : idx;
	}

	// Diamond markers for the user's models, sitting just above the bar of the
	// bin their score falls into. Models sharing a bin stack upward so none are
	// hidden behind another.
	const DIAMOND = 7;
	const markers = $derived.by(() => {
		const perBin = new Map<number, number>();
		return myModels.map((m) => {
			const idx = binIndexFor(m.score);
			const stack = perBin.get(idx) ?? 0;
			perBin.set(idx, stack + 1);
			const barTop = idx >= 0 ? yScale(bins[idx].allCount) : height;
			return {
				model: m,
				x: xScale(m.score),
				y: Math.max(DIAMOND + 2, barTop - DIAMOND - 4 - stack * (DIAMOND * 2 + 4))
			};
		});
	});

	const showZeroLine = $derived(xDomain[0] < 0 && xDomain[1] > 0);

	// Hover tooltip
	let hovered = $state<{ x: number; y: number; model: DistributionModelEntry } | null>(null);
</script>

<div class="chart-container" bind:clientWidth={containerWidth}>
	<!-- Legend -->
	<div class="mb-2 flex flex-wrap items-center gap-4 text-xs retro-text-secondary">
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-3 w-3" style="background: {COLOR_ALL}"></span>
			Unstaked Models
		</span>
		<span class="flex items-center gap-1.5">
			<span class="inline-block h-3 w-3" style="background: {COLOR_STAKED}"></span>
			Staked Models
		</span>
		<span class="flex items-center gap-1.5">
			<svg width="12" height="12" viewBox="0 0 12 12">
				<path d="M6 0 L12 6 L6 12 L0 6 Z" fill={COLOR_MINE} />
			</svg>
			Your Models
		</span>
	</div>

	<div class="relative">
		<svg width={containerWidth} height={HEIGHT} role="img" aria-label="Score distribution histogram">
			<g transform="translate({margin.left},{margin.top})">
				<!-- Y grid + ticks -->
				{#each yTicks as tick}
					<line
						x1="0"
						x2={width}
						y1={yScale(tick)}
						y2={yScale(tick)}
						stroke="var(--retro-light-grey)"
						stroke-opacity="0.4"
					/>
					<text
						x="-8"
						y={yScale(tick)}
						text-anchor="end"
						dominant-baseline="middle"
						class="tick-label"
					>
						{tick}
					</text>
				{/each}

				<!-- X ticks -->
				{#each xTicks as tick}
					<line
						x1={xScale(tick)}
						x2={xScale(tick)}
						y1={height}
						y2={height + 5}
						stroke="var(--retro-light-grey)"
					/>
					<text x={xScale(tick)} y={height + 18} text-anchor="middle" class="tick-label">
						{formatScore(tick)}
					</text>
				{/each}

				<!-- Bars: grey full-field bar with the staked share overlaid from the
				     baseline (stakedCount ≤ allCount, so the grey remainder above it
				     reads as the unstaked share) -->
				{#each bins as bin}
					{@const x = xScale(bin.x0)}
					{@const barWidth = Math.max(xScale(bin.x1) - xScale(bin.x0) - 1, 1)}
					{#if bin.allCount > 0}
						<rect
							{x}
							y={yScale(bin.allCount)}
							width={barWidth}
							height={height - yScale(bin.allCount)}
							fill={COLOR_ALL}
						/>
					{/if}
					{#if bin.stakedCount > 0}
						<rect
							{x}
							y={yScale(bin.stakedCount)}
							width={barWidth}
							height={height - yScale(bin.stakedCount)}
							fill={COLOR_STAKED}
						/>
					{/if}
				{/each}

				<!-- Zero line -->
				{#if showZeroLine}
					<line
						x1={xScale(0)}
						x2={xScale(0)}
						y1="0"
						y2={height}
						stroke="var(--retro-text)"
						stroke-dasharray="4,4"
						stroke-opacity="0.7"
					/>
				{/if}

				<!-- Diamonds for the user's models -->
				{#each markers as marker (marker.model.modelName)}
					<path
						d="M {marker.x} {marker.y - DIAMOND} L {marker.x + DIAMOND} {marker.y} L {marker.x} {marker.y + DIAMOND} L {marker.x - DIAMOND} {marker.y} Z"
						fill={COLOR_MINE}
						stroke="var(--retro-bg-dark)"
						stroke-width="1"
						role="img"
						aria-label="{marker.model.modelName}: {marker.model.percentile.toFixed(1)} percentile"
						onmouseenter={() => (hovered = { x: marker.x, y: marker.y, model: marker.model })}
						onmouseleave={() => (hovered = null)}
					/>
				{/each}

				<!-- Axis labels -->
				<text x={width / 2} y={height + 44} text-anchor="middle" class="axis-label">
					{scoreLabel}
				</text>
				<text
					transform="rotate(-90)"
					x={-height / 2}
					y="-46"
					text-anchor="middle"
					class="axis-label"
				>
					Models
				</text>
			</g>
		</svg>

		{#if hovered}
			<div
				class="tooltip"
				style="left: {hovered.x + margin.left + 12}px; top: {hovered.y + margin.top - 12}px;"
			>
				<div class="font-bold">{hovered.model.modelName}</div>
				<div>Score: {hovered.model.score.toFixed(4)}</div>
				<div>Rank: #{hovered.model.rank}</div>
				<div>Percentile: {hovered.model.percentile.toFixed(1)}%</div>
				<div>{hovered.model.staked ? `Staked: ${hovered.model.stakeValue?.toFixed(2)} NMR` : 'Unstaked'}</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.chart-container {
		width: 100%;
	}

	.tick-label {
		fill: var(--retro-text-dim);
		font-size: 11px;
	}

	.axis-label {
		fill: var(--retro-text);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.tooltip {
		position: absolute;
		pointer-events: none;
		background: var(--retro-bg-dark);
		border: 1px solid var(--retro-primary);
		color: var(--retro-text);
		padding: 6px 10px;
		font-size: 12px;
		white-space: nowrap;
		z-index: 10;
	}
</style>
