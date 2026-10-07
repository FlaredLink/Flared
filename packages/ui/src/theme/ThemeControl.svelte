<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// A viewer's colour theme. System follows prefers-color-scheme; Light and Dark set data-mode on
	// <html>, which tokens.css reads. The choice is a first-party cookie, so the inline script in
	// each app.html applies it before the first paint, also on prerendered pages.
	import { onMount } from 'svelte';

	type ThemeChoice = 'system' | 'light' | 'dark';
	const choices: { value: ThemeChoice; label: string }[] = [
		{ value: 'system', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];
	const id = $props.id();
	// Unknown until the browser reads the cookie, so the server renders no checked option.
	let choice = $state<ThemeChoice | null>(null);

	onMount(() => {
		const saved = document.cookie.match(/(?:^|;\s*)theme=(light|dark)(?:;|$)/)?.[1];
		choice = saved === 'light' || saved === 'dark' ? saved : 'system';
	});

	function select(next: ThemeChoice) {
		choice = next;
		const root = document.documentElement;
		const secure = location.protocol === 'https:' ? '; secure' : '';
		if (next === 'system') {
			delete root.dataset.mode;
			document.cookie = `theme=; path=/; max-age=0; samesite=lax${secure}`;
			return;
		}
		root.dataset.mode = next;
		document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax${secure}`;
	}
</script>

<fieldset class="theme-control">
	<legend>Theme</legend>
	{#each choices as option (option.value)}
		<label class:checked={choice === option.value}>
			<input
				type="radio"
				name={`theme-${id}`}
				value={option.value}
				checked={choice === option.value}
				onchange={() => select(option.value)}
			/>{option.label}
		</label>
	{/each}
</fieldset>

<style>
	.theme-control {
		display: inline-flex;
		gap: 2px;
		margin: 0;
		padding: 2px;
		border: var(--rule);
		border-radius: var(--radius-pill);
		background: var(--color-surface);
	}
	legend {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	label {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 0.7rem;
		border-radius: var(--radius-pill);
		color: var(--color-muted);
		font-size: 0.8125rem;
		cursor: pointer;
	}
	label:hover {
		color: var(--color-strong);
	}
	label.checked {
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
		font-weight: 600;
	}
	label:has(input:focus-visible) {
		outline: 2px solid var(--color-focus);
		outline-offset: 1px;
	}
	input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
</style>
