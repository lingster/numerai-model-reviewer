<script lang="ts">
	/**
	 * Horizontal bar comparison of a single metric across models.
	 *
	 * Extracted from the models page so every metric (Corr20, MMC, Alpha, MPC,
	 * Score, …) renders through one implementation instead of copy-pasted blocks
	 * (DRY). The parent supplies already-resolved values; this component only
	 * handles scaling and presentation.
	 */
	interface MetricEntry {
		/** Display name shown in the row label. */
		name: string;
		/** Owning account, used for the hover title. */
		username: string;
		/** Metric value for the model's latest in-range round (null = no data). */
		value: number | null;
	}

	let {
		label,
		entries,
		positiveClass = 'bg-[var(--retro-success)]',
		negativeClass = 'bg-[var(--retro-error)]',
		decimals = 4
	}: {
		label: string;
		entries: MetricEntry[];
		positiveClass?: string;
		negativeClass?: string;
		decimals?: number;
	} = $props();

	// Scale bars relative to the spread of values so differences are visible.
	// Nulls contribute 0 (matching the original per-metric blocks) so a single
	// missing model never collapses the whole axis.
	const min = $derived(Math.min(...entries.map((e) => e.value ?? 0)));
	const max = $derived(Math.max(...entries.map((e) => e.value ?? 0)));
	const range = $derived(max - min || 1);

	function barWidth(value: number | null): number {
		if (value === null) return 0;
		// Floor at 10% so even the lowest bar stays visible/clickable.
		return Math.max(Math.abs((value - min) / range) * 100, 10);
	}
</script>

<div>
	<h4 class="text-sm font-medium retro-text-primary mb-2">{label}</h4>
	<div class="space-y-2">
		{#each entries as entry}
			<div class="flex items-center gap-3">
				<div
					class="w-32 text-sm retro-text-secondary truncate"
					title="{entry.name} ({entry.username})"
				>
					{entry.name}
				</div>
				<div class="flex-1 retro-bg-secondary rounded-full h-6 relative">
					{#if entry.value !== null}
						<div
							class="h-6 rounded-full flex items-center justify-end pr-2 text-xs text-white font-medium {entry.value >
							0
								? positiveClass
								: negativeClass}"
							style="width: {barWidth(entry.value)}%"
						>
							{entry.value.toFixed(decimals)}
						</div>
					{:else}
						<div
							class="h-6 rounded-full retro-bg-primary flex items-center justify-center text-xs retro-text-secondary"
						>
							N/A
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
