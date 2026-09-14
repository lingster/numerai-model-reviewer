<script lang="ts">
	import GitHubIcon from '$lib/components/GitHubIcon.svelte';
	import { config } from '$lib/config.js';
</script>

<div class="mx-auto max-w-4xl px-2 py-6 sm:px-6 sm:py-8">
	<div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<h1 class="text-4xl font-bold retro-text-accent uppercase tracking-wider">NMR - NUMERAI MODEL REVIEWER</h1>
			<p class="mt-2 text-lg retro-text-secondary">
				► Compare and analyze the performance of Numerai tournament models over time.
			</p>
		</div>
		<a
			href={config.repoUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="retro-button inline-flex items-center gap-2 self-start rounded-md px-3 py-2 text-sm font-medium transition-colors sm:self-auto"
			title="View source on GitHub - PRs welcome!"
		>
			<GitHubIcon />
			<span>GitHub</span>
			<!-- Dark text: --retro-success is a bright green that white text cannot
			     meet contrast requirements against. -->
			<span class="rounded px-1.5 py-0.5 text-xs font-semibold uppercase text-black" style="background-color: var(--retro-success);">
				PRs welcome!
			</span>
		</a>
	</div>
	
	<div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
		<div class="retro-card rounded-lg p-4 sm:p-6">
			<h2 class="mb-3 text-xl font-semibold retro-text-primary uppercase">Model Comparison</h2>
			<p class="mb-4 retro-text-secondary">
				Search for users and their models, compare performance metrics, and visualize results over custom date ranges.
			</p>
			<a
				href="/models"
				class="retro-button inline-flex items-center rounded-md px-4 py-2 text-sm font-medium"
			>
				Start Comparing
				<svg class="ml-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
				</svg>
			</a>
		</div>

		<div class="retro-card rounded-lg p-4 sm:p-6">
			<h2 class="mb-3 text-xl font-semibold retro-text-primary uppercase">Model Rankings</h2>
			<p class="mb-4 retro-text-secondary">
				Track model rank performance over time. Compare against top staked models using custom scoring formulas.
			</p>
			<a
				href="/rankings"
				class="retro-button inline-flex items-center rounded-md px-4 py-2 text-sm font-medium"
			>
				View Rankings
				<svg class="ml-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
				</svg>
			</a>
		</div>

		<div class="retro-card rounded-lg p-4 sm:p-6">
			<h2 class="mb-3 text-xl font-semibold retro-text-primary uppercase">Round Summary</h2>
			<p class="mb-4 retro-text-secondary">
				See the distribution of a metric across all staked models for a single round, with your models marked on the curve.
			</p>
			<a
				href="/round-summary"
				class="retro-button inline-flex items-center rounded-md px-4 py-2 text-sm font-medium"
			>
				View Round Summary
				<svg class="ml-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
				</svg>
			</a>
		</div>

		<div class="retro-card rounded-lg p-4 sm:p-6">
			<h2 class="mb-3 text-xl font-semibold retro-text-primary uppercase">Features</h2>
			<ul class="space-y-2 retro-text-secondary">
				<li class="flex items-center">
					<svg class="mr-2 h-4 w-4 retro-text-success" fill="currentColor" viewBox="0 0 20 20">
						<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
					</svg>
					Autocomplete user & model search
				</li>
				<li class="flex items-center">
					<svg class="mr-2 h-4 w-4 retro-text-success" fill="currentColor" viewBox="0 0 20 20">
						<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
					</svg>
					Performance charts & tables
				</li>
				<li class="flex items-center">
					<svg class="mr-2 h-4 w-4 retro-text-success" fill="currentColor" viewBox="0 0 20 20">
						<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
					</svg>
					Custom score ranking formulas
				</li>
				<li class="flex items-center">
					<svg class="mr-2 h-4 w-4 retro-text-success" fill="currentColor" viewBox="0 0 20 20">
						<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
					</svg>
					URL-based sharing
				</li>
			</ul>
		</div>

		<div class="retro-card rounded-lg p-4 sm:p-6">
			<h2 class="mb-3 text-xl font-semibold retro-text-primary uppercase flex items-center gap-2">
				<GitHubIcon />
				Open Source
			</h2>
			<p class="mb-4 retro-text-secondary">
				Built with SvelteKit & Cloudflare. Fork, inspect, or contribute: Pull Requests are warmly welcome!
			</p>
			<a
				href={config.repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="retro-button inline-flex items-center rounded-md px-4 py-2 text-sm font-medium"
			>
				Contribute on GitHub
				<svg class="ml-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
				</svg>
			</a>
		</div>
	</div>
</div>
