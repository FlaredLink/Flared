<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	// A viewer's colour theme. System follows prefers-color-scheme; Light and Dark set data-mode on
	// <html>, which tokens.css reads. The choice is a first-party cookie, so the inline script in
	// each app.html applies it before the first paint, also on prerendered pages.
	export type ThemeChoice = 'system' | 'light' | 'dark';

	export function savedTheme(): ThemeChoice {
		const saved = document.cookie.match(/(?:^|;\s*)theme=(light|dark)(?:;|$)/)?.[1];
		return saved === 'light' || saved === 'dark' ? saved : 'system';
	}

	export function applyTheme(next: ThemeChoice): void {
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

<script lang="ts">
	// A compact theme switch for a footer or menu; Settings uses ThemeSetting.
	import { onMount } from 'svelte';

	// Phosphor regular icons (MIT): monitor, sun, and moon. The label stays for screen readers and
	// as the tooltip.
	const choices: { value: ThemeChoice; label: string; icon: string }[] = [
		{
			value: 'system',
			label: 'System',
			icon: 'M208,40H48A24,24,0,0,0,24,64V176a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V64A24,24,0,0,0,208,40Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H208a8,8,0,0,1,8,8Zm-48,48a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,224Z'
		},
		{
			value: 'light',
			label: 'Light',
			icon: 'M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z'
		},
		{
			value: 'dark',
			label: 'Dark',
			icon: 'M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z'
		}
	];
	const id = $props.id();
	// Unknown until the browser reads the cookie, so the server renders no checked option.
	let choice = $state<ThemeChoice | null>(null);

	onMount(() => {
		choice = savedTheme();
	});

	function select(next: ThemeChoice) {
		choice = next;
		applyTheme(next);
	}
</script>

<fieldset class="theme-control">
	<legend>Theme</legend>
	{#each choices as option (option.value)}
		<label class:checked={choice === option.value} title={option.label}>
			<input
				type="radio"
				name={`theme-${id}`}
				value={option.value}
				checked={choice === option.value}
				onchange={() => select(option.value)}
			/><svg viewBox="0 0 256 256" width="16" height="16" fill="currentColor" aria-hidden="true"
				><path d={option.icon} /></svg
			><span class="visually-hidden">{option.label}</span>
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
	legend,
	.visually-hidden {
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
		justify-content: center;
		width: 32px;
		min-height: 32px;
		border-radius: var(--radius-pill);
		color: var(--color-muted);
		cursor: pointer;
	}
	label:hover {
		color: var(--color-strong);
	}
	label.checked {
		background: var(--color-accent-soft);
		color: var(--color-accent-ink);
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
