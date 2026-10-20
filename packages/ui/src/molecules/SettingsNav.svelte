<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { GlyphName } from '../icons/Glyph.svelte';

	export interface SettingsSection {
		href: string;
		label: string;
		icon: GlyphName;
	}

	// A labelled group, such as the person's account or the active workspace. detail names the
	// group's subject, such as the workspace name.
	export interface SettingsGroup {
		id: string;
		label: string;
		detail?: string;
		sections: SettingsSection[];
	}
</script>

<script lang="ts">
	import Glyph from '../icons/Glyph.svelte';
	import Select from '../atoms/Select.svelte';

	interface Props {
		groups: SettingsGroup[];
		// The href of the open section.
		current: string;
		// The narrow-screen select navigates through this, such as SvelteKit's goto.
		onselect: (href: string) => void;
	}
	let { groups, current, onselect }: Props = $props();
</script>

<!-- Below 64rem one select replaces the list; the page puts its content under it there. -->
<nav class="sections" aria-label="Settings">
	{#each groups as group (group.id)}
		<p class="group-label" id="settings-group-{group.id}">
			{group.label}{#if group.detail}<span class="visually-hidden">: </span><span
					class="group-detail">{group.detail}</span
				>{/if}
		</p>
		<ul aria-labelledby="settings-group-{group.id}">
			{#each group.sections as section (section.href)}
				<li>
					<a href={section.href} aria-current={section.href === current ? 'page' : undefined}
						><Glyph name={section.icon} size={20} />{section.label}</a
					>
				</li>
			{/each}
		</ul>
	{/each}
</nav>

<label class="section-select">
	<span class="visually-hidden">Settings section</span>
	<Select value={current} onchange={(event) => onselect(event.currentTarget.value)}>
		{#each groups as group (group.id)}
			<optgroup label={group.detail ? `${group.label}: ${group.detail}` : group.label}>
				{#each group.sections as section (section.href)}<option value={section.href}
						>{section.label}</option
					>{/each}
			</optgroup>
		{/each}
	</Select>
</label>

<style>
	/* Base: one select for every width below 64rem; the page puts its content under it. */
	.sections {
		display: none;
	}
	.section-select {
		display: grid;
	}
	.section-select :global(.select) {
		width: 100%;
	}
	.group-label {
		display: grid;
		padding: 0 0.625rem;
		color: var(--color-subtle);
		font-size: 0.8125rem;
		font-weight: 600;
	}
	ul + .group-label {
		margin-top: 1.25rem;
	}
	.group-detail {
		overflow: hidden;
		color: var(--color-strong);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	ul {
		display: grid;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	a {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		border-radius: 0.5625rem;
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	a:hover {
		color: var(--color-strong);
	}
	/* The open section is a raised surface with the ring, as in the app sidebar. */
	a[aria-current='page'] {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font-weight: 500;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	@media (min-width: 64rem) {
		.sections {
			position: sticky;
			top: 5.25rem;
			display: grid;
			align-content: start;
			gap: 0.35rem;
		}
		.section-select {
			display: none;
		}
	}
</style>
