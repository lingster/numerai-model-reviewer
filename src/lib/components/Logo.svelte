<script lang="ts">
	/**
	 * numerdiff brand mark + wordmark.
	 *
	 * The icon is a 16-bit-styled pixel grid showing two diverging performance
	 * lines (one rising, one falling) that cross — the visual metaphor for the
	 * app's job: diffing two models' scores over time. Renders as an <a> to the
	 * home page so it doubles as the top-left "back home" affordance on every
	 * page. Colours are drawn straight from the retro palette so the mark stays
	 * on-brand regardless of the per-page tournament theme.
	 */
	let { href = '/' }: { href?: string } = $props();
</script>

<a
	{href}
	class="logo group inline-flex items-center gap-2.5 no-underline"
	aria-label="numerdiff — go to home"
>
	<svg
		class="logo-icon retro-pixelated h-8 w-8 shrink-0 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:-translate-x-0.5"
		viewBox="0 0 24 24"
		fill="none"
		role="img"
		aria-hidden="true"
		shape-rendering="crispEdges"
	>
		<!-- bezel -->
		<rect x="1" y="1" width="22" height="22" fill="#1A1A1A" stroke="#FF6B35" stroke-width="2" />
		<!-- rising line (green / "+") -->
		<path
			d="M3 18 H7 V14 H11 V10 H15 V6 H21"
			stroke="#00FF88"
			stroke-width="2"
			stroke-linejoin="miter"
		/>
		<!-- falling line (crimson / "-") -->
		<path
			d="M3 6 H7 V10 H11 V14 H15 V18 H21"
			stroke="#DC143C"
			stroke-width="2"
			stroke-linejoin="miter"
		/>
		<!-- crossover pixel: where the two diverge -->
		<rect x="11" y="11" width="2" height="2" fill="#00C0D0" />
	</svg>

	<span class="logo-word text-xl font-bold tracking-wider lowercase select-none">
		<span class="logo-word-numer">numer</span><span class="logo-word-diff">diff</span>
	</span>
</a>

<style>
	.logo-word {
		font-family: 'Courier New', monospace;
		line-height: 1;
	}
	.logo-word-numer {
		color: var(--retro-text);
	}
	.logo-word-diff {
		/* the "diff" half pops in the accent colour, like a highlighted change */
		color: var(--retro-accent);
		text-shadow: 2px 2px 0 #1a1a1a;
	}
	.logo:hover .logo-word-diff {
		color: var(--retro-warning);
	}
	.logo:focus-visible {
		outline: 2px solid var(--retro-accent);
		outline-offset: 3px;
		border-radius: 2px;
	}
</style>
