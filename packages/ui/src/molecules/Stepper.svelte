<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';

	// Steps before current are done; the rest are still to do.
	let { steps, current, label }: { steps: string[]; current: number; label: string } = $props();
</script>

<ol class="stepper" aria-label={label}>
	{#each steps as step, index (step)}
		<li
			class:done={index < current}
			class:current={index === current}
			aria-current={index === current ? 'step' : undefined}
		>
			<span class="mark">
				{#if index < current}<Glyph name="check" size={14} /><span class="visually-hidden"
						>Done:</span
					>{:else}{index + 1}{/if}
			</span>
			<span class="name">{step}</span>
		</li>
	{/each}
</ol>

<style>
	.stepper {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
		container-type: inline-size;
	}
	li {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-muted);
		font-size: 0.875rem;
		white-space: nowrap;
	}
	li:last-child {
		flex: none;
	}
	li:not(:last-child)::after {
		content: '';
		flex: 1;
		min-width: 1.5rem;
		height: 1px;
		margin-left: 0.4rem;
		background: var(--color-rule);
	}
	.mark {
		display: grid;
		flex: none;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--color-surface-3);
		color: var(--color-ink);
		font-size: 0.75rem;
		font-weight: 600;
	}
	.done .mark {
		color: var(--color-strong);
	}
	.current {
		color: var(--color-strong);
		font-weight: 600;
	}
	.current .mark {
		background: var(--color-button-primary);
		color: var(--color-on-primary);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	/* Base: only the current step shows its name. A wide stepper names every step. */
	.name {
		display: none;
	}
	.current .name {
		display: inline;
	}
	@container (min-width: 30rem) {
		.name {
			display: inline;
		}
	}
</style>
