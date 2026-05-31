<script lang="ts">
	import '../app.css';
	import Logo from '$lib/components/Logo.svelte';

	let { children } = $props();
</script>

<header class="site-header retro-bg-primary">
	<div class="flex items-center px-4 py-3 sm:px-6">
		<Logo href="/" />
	</div>
</header>

{@render children()}

<style>
	.site-header {
		border-bottom: 2px solid var(--retro-primary);
		box-shadow: 0 2px 0 var(--retro-primary-dark);
	}
</style>
