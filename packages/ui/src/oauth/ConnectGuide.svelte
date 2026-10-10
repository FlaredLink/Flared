<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';
	import AssistantTile from './AssistantTile.svelte';
	import { assistants, type AssistantId } from './assistants';

	interface Props {
		// The assistant whose setup is open in the panel, or null.
		selected: AssistantId | null;
		onselect: (assistant: AssistantId) => void;
	}
	let { selected, onselect }: Props = $props();
</script>

<section class="connect" aria-labelledby="connect-heading">
	<div class="titles">
		<h2 id="connect-heading">Connect an assistant</h2>
		<p>Choose an app to see its setup steps.</p>
	</div>
	<ul>
		{#each assistants as assistant (assistant.id)}
			<li class:selected={selected === assistant.id}>
				<button
					type="button"
					aria-expanded={selected === assistant.id}
					aria-controls="assistant-setup"
					onclick={() => onselect(assistant.id)}
				>
					<AssistantTile assistant={assistant.id} />
					<span class="text"
						><span class="name">{assistant.label}</span><span class="line">{assistant.line}</span
						></span
					>
					<span class="action"
						>{assistant.id === 'other' ? 'View setup' : 'Set up'}<Glyph
							name="arrow"
							size={18}
						/></span
					>
				</button>
			</li>
		{/each}
	</ul>
</section>

<style>
	.connect {
		display: grid;
		gap: 1rem;
	}
	.titles {
		display: grid;
		gap: 0.25rem;
	}
	h2 {
		color: var(--color-strong);
		font-size: 1.375rem;
		font-weight: 750;
		letter-spacing: -0.025em;
	}
	.titles p {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--color-rule);
	}
	li {
		position: relative;
		border-bottom: 1px solid var(--color-rule);
	}
	li.selected {
		background: var(--color-accent-soft);
	}
	li.selected::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 3px;
		background: var(--color-accent);
	}
	button {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 1.1rem;
		width: 100%;
		min-height: 5.25rem;
		padding: 0.75rem 1.25rem;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	li:not(.selected) button:hover {
		background: var(--color-hover);
	}
	.text {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.name {
		color: var(--color-strong);
		font-size: 1.0625rem;
		font-weight: 600;
	}
	.line {
		color: var(--color-lead);
		font-size: 0.9375rem;
	}
	.action {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-link);
		font-size: 1rem;
	}
	.selected .action {
		color: var(--color-accent-ink);
	}
	@media (max-width: 30rem) {
		button {
			gap: 0.85rem;
			padding-inline: 0.85rem;
		}
		.action {
			font-size: 0.9375rem;
		}
	}
</style>
