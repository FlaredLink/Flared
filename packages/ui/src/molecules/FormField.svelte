<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		// The control's id; the label points at it.
		for: string;
		label: string;
		hint?: string;
		error?: string | null;
		children: Snippet;
	}
	let { for: htmlFor, label, hint, error, children }: Props = $props();
</script>

<div class="form-field">
	<label for={htmlFor}>{label}</label>
	{#if hint}<p class="hint" id="{htmlFor}-hint">{hint}</p>{/if}
	{@render children()}
	{#if error}<p class="error" id="{htmlFor}-error" role="alert">{error}</p>{/if}
</div>

<style>
	.form-field {
		display: grid;
		gap: 0.45rem;
		min-width: 0;
	}
	label {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.hint {
		margin-top: -0.2rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
