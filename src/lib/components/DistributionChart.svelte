<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3Array from 'd3-array';
	import * as d3Scale from 'd3-scale';
	import { binIndexOf, type HistogramBin } from '$lib/utils/histogram.js';

	export interface Highlight {
		label: string;
		value: number;
		/** Extra line for the tooltip, e.g. "Rank 12 / 4000". */
		detail?: string;
		/** 'staked' (black) is the default; 'unstaked' renders amber. */
		variant?: 'staked' | 'unstaked';
	}

	/** A model's value used to populate per-bar "top models" tooltips. */
	export interface BarPoint {
		label: string;
		value: number;
	}

	let {
		bins = [],
		highlights = [],
		points = [],
		axisLabel = '',
		signed = false,
		selectedBin = -1,
		onBarSelect,
		formatValue = (n: number) => n.toFixed(4)
	}: {
		bins: HistogramBin[];
		highlights: Highlight[];
		/** Every model's value, so each bar can list its members on hover. */
		points?: BarPoint[];
		axisLabel: string;
		/** When true, draw a bold x=0 line and colour bars green (≥0) / red (<0). */
		signed?: boolean;
		/** Index of the currently selected bar (outlined); -1 for none. */
		selectedBin?: number;
		/** Fired when a non-empty bar is clicked, with its bin index. */
		onBarSelect?: (binIndex: number) => void;
		formatValue?: (n: number) => string;
	} = $props();

	// Bucket points into the same bins as the bars (sorted best-first by value),
	// so hovering a bar can show its top members.
	const binMembers = $derived.by<BarPoint[][]>(() => {
		if (bins.length === 0) return [];
		const buckets: BarPoint[][] = bins.map(() => []);
		for (const p of points) {
			const idx = binIndexOf(p.value, bins);
			if (idx >= 0) buckets[idx].push(p);
		}
		return buckets.map((b) => b.sort((a, c) => c.value - a.value));
	});

	/** Bar colour: by sign of the bin midpoint when `signed`, else the theme primary. */
	function barFill(b: HistogramBin): string {
		if (!signed) return 'var(--retro-primary)';
		return (b.x0 + b.x1) / 2 >= 0 ? 'var(--retro-success)' : 'var(--retro-error)';
	}

	const margin = { top: 30, right: 24, bottom: 50, left: 56 };
	const BASE_HEIGHT = 360;
	let containerWidth = $state(800);
	const containerHeight = BASE_HEIGHT;

	const width = $derived(Math.max(containerWidth - margin.left - margin.right, 100));
	const height = $derived(Math.max(containerHeight - margin.top - margin.bottom, 100));

	// X domain spans the bin edges, widened if any highlight falls outside.
	const xDomain = $derived.by<[number, number]>(() => {
		if (bins.length === 0) return [0, 1];
		let lo = bins[0].x0;
		let hi = bins[bins.length - 1].x1;
		for (const h of highlights) {
			if (Number.isFinite(h.value)) {
				lo = Math.min(lo, h.value);
				hi = Math.max(hi, h.value);
			}
		}
		return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
	});

	const yMax = $derived(Math.max(d3Array.max(bins, (b) => b.count) ?? 1, 1));

	const xScale = $derived(d3Scale.scaleLinear().domain(xDomain).range([0, width]));
	const yScale = $derived(d3Scale.scaleLinear().domain([0, yMax]).range([height, 0]).nice());

	const xTicks = $derived(xScale.ticks(8));
	const yTicks = $derived(yScale.ticks(5));

	// Show the x=0 reference line only for signed metrics where 0 is in range.
	const showZeroLine = $derived(signed && xDomain[0] <= 0 && xDomain[1] >= 0);

	// Lay out diamonds: each sits just above the bar of the bin it falls into;
	// collisions in the same bin stack upward so all stay visible & hoverable.
	interface PlacedDiamond extends Highlight {
		cx: number;
		cy: number;
	}
	// Diamond size/spacing. Each diamond starts just above the bar of the bin it
	// lands in, then is bumped straight up until it clears every already-placed
	// diamond — so overlapping values (same or neighbouring bins) stack vertically
	// with no overlap, anywhere on the x-axis.
	const DIAMOND_STEP = 14;
	const MIN_GAP_X = 13;
	const placedDiamonds = $derived.by<PlacedDiamond[]>(() => {
		const out: PlacedDiamond[] = [];
		// Pack left→right for a stable, deterministic layout.
		const ordered = highlights
			.filter((h) => Number.isFinite(h.value))
			.slice()
			.sort((a, b) => a.value - b.value);
		for (const h of ordered) {
			const cx = xScale(h.value);
			const binIdx = binIndexOf(h.value, bins);
			const barTop = bins[binIdx] ? yScale(bins[binIdx].count) : height;
			let cy = Math.max(10, barTop - 12);
			let guard = 0;
			while (
				guard++ < 500 &&
				out.some((p) => Math.abs(p.cx - cx) < MIN_GAP_X && Math.abs(p.cy - cy) < DIAMOND_STEP)
			) {
				cy -= DIAMOND_STEP;
			}
			out.push({ ...h, cx, cy: Math.max(6, cy) });
		}
		return out;
	});

	const diamondFill = (h: Highlight) =>
		h.variant === 'unstaked' ? 'var(--retro-warning)' : '#111';

	let tooltip = $state<{ visible: boolean; x: number; y: number; h: Highlight | null }>({
		visible: false,
		x: 0,
		y: 0,
		h: null
	});

	function showTip(d: PlacedDiamond) {
		tooltip = { visible: true, x: d.cx + margin.left, y: d.cy + margin.top, h: d };
	}
	function hideTip() {
		tooltip = { ...tooltip, visible: false };
	}

	// Per-bar tooltip: top 5 models in the hovered bar.
	const TOP_N = 5;
	let barTip = $state<{ visible: boolean; x: number; y: number; idx: number }>({
		visible: false,
		x: 0,
		y: 0,
		idx: -1
	});
	function showBar(idx: number) {
		const b = bins[idx];
		if (!b || b.count === 0) return;
		barTip = {
			visible: true,
			x: xScale((b.x0 + b.x1) / 2) + margin.left,
			y: yScale(b.count) + margin.top,
			idx
		};
	}
	function hideBar() {
		barTip = { ...barTip, visible: false };
	}

	let chartContainer: HTMLDivElement;
	onMount(() => {
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) containerWidth = e.contentRect.width;
		});
		if (chartContainer) ro.observe(chartContainer);
		return () => ro.disconnect();
	});
</script>

<div class="distribution-chart" bind:this={chartContainer}>
	<!-- Legend -->
	<div class="mb-2 flex flex-wrap items-center gap-4 text-xs retro-text-secondary">
		{#if signed}
			<span class="flex items-center gap-1">
				<span class="inline-block h-3 w-3" style="background-color: var(--retro-success);"></span>
				≥ 0
			</span>
			<span class="flex items-center gap-1">
				<span class="inline-block h-3 w-3" style="background-color: var(--retro-error);"></span>
				&lt; 0
			</span>
		{:else}
			<span class="flex items-center gap-1">
				<span class="inline-block h-3 w-3" style="background-color: var(--retro-primary);"></span>
				Staked models
			</span>
		{/if}
		<span class="flex items-center gap-1">
			<span class="diamond-swatch"></span>
			Your models
		</span>
		<span class="flex items-center gap-1">
			<span class="diamond-swatch" style="background-color: var(--retro-warning);"></span>
			Your models (unstaked)
		</span>
	</div>

	<div class="relative">
		<svg
			width={containerWidth}
			height={containerHeight}
			role="img"
			aria-label="Distribution of {axisLabel} across staked models"
		>
			<g transform="translate({margin.left}, {margin.top})">
				<!-- Y grid + ticks -->
				{#each yTicks as t}
					<line x1="0" y1={yScale(t)} x2={width} y2={yScale(t)} stroke="var(--retro-light-grey)" stroke-opacity="0.3" stroke-dasharray="4,4" />
					<text x="-10" y={yScale(t)} dy="0.32em" text-anchor="end" font-size="11" fill="var(--retro-text-dim)">{t}</text>
				{/each}

				<!-- Bars -->
				{#each bins as b, i}
					{@const x = xScale(b.x0)}
					{@const w = Math.max(xScale(b.x1) - xScale(b.x0) - 1, 0.5)}
					{@const y = yScale(b.count)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<rect
						{x}
						{y}
						width={w}
						height={Math.max(height - y, 0)}
						fill={barFill(b)}
						fill-opacity={barTip.visible && barTip.idx === i ? '1' : '0.7'}
						stroke={i === selectedBin ? 'var(--retro-text)' : 'none'}
						stroke-width={i === selectedBin ? 2 : 0}
						class={b.count > 0 ? 'bar' : ''}
						role={b.count > 0 ? 'button' : undefined}
						tabindex={b.count > 0 ? 0 : undefined}
						aria-label={b.count > 0 ? `${b.count} models between ${formatValue(b.x0)} and ${formatValue(b.x1)}` : undefined}
						onmouseenter={() => showBar(i)}
						onmouseleave={hideBar}
						onfocus={() => showBar(i)}
						onblur={hideBar}
						onclick={() => b.count > 0 && onBarSelect?.(i)}
						onkeydown={(e) => {
							if (b.count > 0 && (e.key === 'Enter' || e.key === ' ')) {
								e.preventDefault();
								onBarSelect?.(i);
							}
						}}
					/>
				{/each}

				<!-- x=0 reference line (signed metrics) -->
				{#if showZeroLine}
					<line x1={xScale(0)} y1="0" x2={xScale(0)} y2={height} stroke="var(--retro-text)" stroke-width="2" stroke-dasharray="6,3" />
					<text x={xScale(0)} y="-8" text-anchor="middle" font-size="11" font-weight="bold" fill="var(--retro-text)">0</text>
				{/if}

				<!-- X axis -->
				<g transform="translate(0, {height})">
					<line x1="0" y1="0" x2={width} y2="0" stroke="var(--retro-text-dim)" />
					{#each xTicks as t}
						<g transform="translate({xScale(t)}, 0)">
							<line y1="0" y2="6" stroke="var(--retro-text-dim)" />
							<text y="20" text-anchor="middle" font-size="11" fill="var(--retro-text-dim)">{formatValue(t)}</text>
						</g>
					{/each}
					<text x={width / 2} y="42" text-anchor="middle" font-size="13" font-weight="bold" fill="var(--retro-text)">{axisLabel}</text>
				</g>

				<!-- Y axis line + label -->
				<line x1="0" y1="0" x2="0" y2={height} stroke="var(--retro-text-dim)" />
				<text transform="rotate(-90)" x={-height / 2} y="-42" text-anchor="middle" font-size="13" font-weight="bold" fill="var(--retro-text)">Models</text>

				<!-- Highlight diamonds (your models) -->
				{#each placedDiamonds as d}
					<path
						d="M {d.cx} {d.cy - 6} L {d.cx + 6} {d.cy} L {d.cx} {d.cy + 6} L {d.cx - 6} {d.cy} Z"
						fill={diamondFill(d)}
						stroke="#fff"
						stroke-width="1"
						class="diamond"
						role="button"
						tabindex="0"
						aria-label="{d.label}: {formatValue(d.value)}"
						onmouseenter={() => showTip(d)}
						onmouseleave={hideTip}
						onfocus={() => showTip(d)}
						onblur={hideTip}
					/>
				{/each}
			</g>
		</svg>

		{#if tooltip.visible && tooltip.h}
			<div
				class="pointer-events-none absolute z-10 retro-bg-secondary border-2 border-[var(--retro-primary)] rounded-lg p-2 shadow-lg"
				style="left: {tooltip.x + 10}px; top: {tooltip.y - 10}px; transform: translate(0, -100%);"
			>
				<div class="text-sm font-bold retro-text-primary">{tooltip.h.label}</div>
				<div class="text-xs retro-text-accent">{axisLabel}: {formatValue(tooltip.h.value)}</div>
				{#if tooltip.h.detail}
					<div class="text-xs retro-text-secondary">{tooltip.h.detail}</div>
				{/if}
			</div>
		{/if}

		{#if barTip.visible && bins[barTip.idx]}
			{@const b = bins[barTip.idx]}
			{@const members = binMembers[barTip.idx] ?? []}
			<div
				class="pointer-events-none absolute z-10 retro-bg-secondary border-2 border-[var(--retro-primary)] rounded-lg p-2 shadow-lg"
				style="left: {barTip.x + 10}px; top: {barTip.y - 10}px; transform: translate(-50%, -100%);"
			>
				<div class="text-xs font-bold retro-text-primary">
					{b.count} model{b.count === 1 ? '' : 's'} · {axisLabel} {formatValue(b.x0)} to {formatValue(b.x1)}
				</div>
				<div class="mt-1 text-xs retro-text-secondary">Top {Math.min(TOP_N, members.length)} by {axisLabel}:</div>
				<ul class="text-xs retro-text-primary">
					{#each members.slice(0, TOP_N) as p}
						<li class="flex justify-between gap-3"><span>{p.label}</span><span class="retro-text-accent">{formatValue(p.value)}</span></li>
					{/each}
				</ul>
				{#if b.count > TOP_N}
					<div class="text-xs retro-text-secondary">+ {b.count - TOP_N} more</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.distribution-chart {
		width: 100%;
	}
	svg {
		display: block;
	}
	.bar {
		cursor: pointer;
	}
	.diamond {
		cursor: pointer;
	}
	.diamond:hover {
		fill: var(--retro-accent);
	}
	.diamond-swatch {
		width: 0.7rem;
		height: 0.7rem;
		background-color: #111;
		transform: rotate(45deg);
		display: inline-block;
	}
</style>
