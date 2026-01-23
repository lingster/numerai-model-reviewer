<script lang="ts">
	import type { AutocompleteOption } from '$lib/types.js';

	interface Props {
		id?: string;
		value?: string;
		options?: AutocompleteOption[];
		placeholder?: string;
		loading?: boolean;
		disabled?: boolean;
		selectOnClick?: boolean;
		oninputvalue?: (value: string) => void;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		onselect?: (value: any) => void;
		class?: string;
	}

	let {
		id = '',
		value = $bindable(''),
		options = [],
		placeholder = 'Search...',
		loading = false,
		disabled = false,
		selectOnClick = false,
		oninputvalue,
		onselect,
		class: className = ''
	}: Props = $props();

	let isOpen = $state(false);
	let highlightedIndex = $state(-1);
	let inputElement: HTMLInputElement | undefined = $state();

	// Generate a stable random suffix for fallback IDs
	const randomSuffix = Math.random().toString(36).slice(2);

	// Generate unique ID for the listbox (reactive to id prop)
	const listboxId = $derived(id ? `${id}-listbox` : `autocomplete-listbox-${randomSuffix}`);

	// Filter options based on input value
	const filteredOptions = $derived(
		options.filter((option) =>
			option.label.toLowerCase().includes((value || '').toLowerCase())
		)
	);

	function handleInput(event: Event) {
		const nextValue = (event.target as HTMLInputElement).value;
		isOpen = true;
		highlightedIndex = -1;
		oninputvalue?.(nextValue);
	}

	function handleFocus() {
		if (options.length > 0) {
			isOpen = true;
		}
	}

	function handleBlur() {
		// Delay closing to allow click events to fire
		setTimeout(() => {
			isOpen = false;
			highlightedIndex = -1;
		}, 150);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!isOpen || filteredOptions.length === 0) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				isOpen = true;
			}
			return;
		}

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				highlightedIndex = Math.min(highlightedIndex + 1, filteredOptions.length - 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				highlightedIndex = Math.max(highlightedIndex - 1, 0);
				break;
			case 'Enter':
				event.preventDefault();
				if (highlightedIndex >= 0 && highlightedIndex < filteredOptions.length) {
					selectOption(filteredOptions[highlightedIndex]);
				}
				break;
			case 'Escape':
				event.preventDefault();
				isOpen = false;
				highlightedIndex = -1;
				break;
		}
	}

	function handleClick() {
		if (!selectOnClick || !value || disabled) {
			return;
		}

		requestAnimationFrame(() => {
			inputElement?.select();
		});
	}

	function selectOption(option: AutocompleteOption) {
		value = option.label;
		isOpen = false;
		highlightedIndex = -1;

		if (onselect) {
			onselect(option.value);
		}

		// Blur input after selection
		inputElement?.blur();
	}

	function handleOptionClick(option: AutocompleteOption) {
		selectOption(option);
	}

	function handleOptionMouseEnter(index: number) {
		highlightedIndex = index;
	}

	// Reset value when clearing
	$effect(() => {
		if (value === '' && isOpen) {
			highlightedIndex = -1;
		}
	});
</script>

<div class="relative {className}">
	<input
		bind:this={inputElement}
		{id}
		type="text"
		bind:value
		{placeholder}
		{disabled}
		autocomplete="off"
		oninput={handleInput}
		onfocus={handleFocus}
		onblur={handleBlur}
		onkeydown={handleKeydown}
		onclick={handleClick}
		class="retro-input w-full rounded-md px-3 py-2 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
		aria-expanded={isOpen}
		aria-haspopup="listbox"
		aria-autocomplete="list"
		aria-controls={listboxId}
		role="combobox"
	/>

	{#if loading}
		<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
			<svg
				class="h-4 w-4 animate-spin retro-text-accent"
				xmlns="http://www.w3.org/2000/svg"
				fill="none"
				viewBox="0 0 24 24"
			>
				<circle
					class="opacity-25"
					cx="12"
					cy="12"
					r="10"
					stroke="currentColor"
					stroke-width="4"
				></circle>
				<path
					class="opacity-75"
					fill="currentColor"
					d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
				></path>
			</svg>
		</div>
	{/if}

	{#if isOpen && filteredOptions.length > 0 && !disabled}
		<ul
			id={listboxId}
			class="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md retro-bg-secondary py-1 shadow-lg border-2 border-[var(--retro-primary)]"
			role="listbox"
		>
			{#each filteredOptions as option, index}
				<li
					role="option"
					aria-selected={highlightedIndex === index}
					class="cursor-pointer px-3 py-2 text-sm {highlightedIndex === index
						? 'retro-bg-accent text-white'
						: 'retro-text-primary hover:retro-bg-primary'}"
					onmousedown={() => handleOptionClick(option)}
					onmouseenter={() => handleOptionMouseEnter(index)}
				>
					{option.label}
				</li>
			{/each}
		</ul>
	{/if}

	{#if isOpen && filteredOptions.length === 0 && value && !loading && !disabled}
		<div
			class="absolute z-50 mt-1 w-full rounded-md retro-bg-secondary py-2 px-3 text-sm retro-text-secondary shadow-lg border-2 border-[var(--retro-light-grey)]"
		>
			No results found
		</div>
	{/if}
</div>
