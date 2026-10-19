<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { untrack } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';

	interface Props {
		// The current ?q= and ?domain= of this page, which passes them to GET /v1/links.
		search: string;
		domainId: string;
		domains: { id: string; hostname: string }[];
		// 'bar': a compact search and a domain select for a page bar. 'under': a full-width search
		// and domain chips for a phone screen.
		placement?: 'bar' | 'under';
		// The search field, for a shortcut that focuses it.
		searchInput?: HTMLInputElement;
	}
	let { search, domainId, domains, placement = 'bar', searchInput = $bindable() }: Props = $props();

	// The search runs as the person types. The field keeps its own text, so a response for an
	// earlier query cannot overwrite keys typed since; it follows the URL only while unfocused.
	let query = $state(untrack(() => search));
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const current = search;
		if (document.activeElement !== searchInput) query = current;
	});

	function searchSoon(form: HTMLFormElement | null) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			if (query.trim() !== search) form?.requestSubmit();
		}, 300);
	}

	// A chip keeps the search and sets the domain; the first chip clears it.
	function domainHref(id: string): string {
		const params = new URLSearchParams();
		if (search) params.set('q', search);
		if (id) params.set('domain', id);
		const text = params.toString();
		return text ? `?${text}` : '?';
	}
</script>

<!-- SvelteKit runs this GET form in place: focus and scroll stay, and history gets no entry per
     typed query. -->
<form
	class="filters {placement}"
	method="get"
	role="search"
	aria-label="Filter links"
	data-sveltekit-keepfocus
	data-sveltekit-noscroll
	data-sveltekit-replacestate
	onsubmit={() => clearTimeout(searchTimer)}
>
	<label class="search">
		<span class="visually-hidden">Search links</span>
		<Glyph name="search" size={placement === 'bar' ? 16 : 18} />
		<input
			type="search"
			name="q"
			bind:value={query}
			oninput={(event) => searchSoon(event.currentTarget.form)}
			placeholder="Search links"
			maxlength="100"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			inputmode="search"
			enterkeyhint="search"
			bind:this={searchInput}
		/>
	</label>
	{#if domains.length > 1}
		{#if placement === 'bar'}
			<label class="domain">
				<span class="visually-hidden">Domain</span>
				<select
					name="domain"
					value={domainId}
					onchange={(event) => event.currentTarget.form?.requestSubmit()}
				>
					<option value="">All domains</option>
					{#each domains as domain (domain.id)}
						<option value={domain.id}>{domain.hostname}</option>
					{/each}
				</select>
				<Glyph name="caretDown" size={14} />
			</label>
		{:else}
			{#if domainId}<input type="hidden" name="domain" value={domainId} />{/if}
			<nav class="chips" aria-label="Domain">
				<a href={domainHref('')} aria-current={domainId === '' ? 'true' : undefined}
					><span>All domains</span></a
				>
				{#each domains as domain (domain.id)}
					<a href={domainHref(domain.id)} aria-current={domainId === domain.id ? 'true' : undefined}
						><span>{domain.hostname}</span></a
					>
				{/each}
			</nav>
		{/if}
	{/if}
</form>

<style>
	.filters {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.under {
		flex-direction: column;
		align-items: stretch;
		width: 100%;
	}
	.search,
	.domain {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: 0.5625rem;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-subtle);
	}
	.search {
		gap: 0.5rem;
		padding: 0 0.625rem;
	}
	.search:focus-within,
	.domain:focus-within {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	input {
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-strong);
		font: inherit;
		/* 16px, so iOS does not zoom into the field. */
		font-size: 1rem;
		outline: none;
	}
	input::placeholder {
		color: var(--color-subtle);
	}
	/* Phone: a 44px search over the full width, then a row of chips that scrolls sideways. */
	.under .search {
		min-height: 2.75rem;
		border-radius: 0.75rem;
	}
	.chips {
		display: flex;
		gap: 0.375rem;
		margin-inline: calc(var(--page-bleed, 0px) * -1);
		padding-inline: var(--page-bleed, 0px);
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.chips a {
		display: inline-flex;
		flex: none;
		align-items: center;
		min-height: 2.75rem;
	}
	.chips span {
		display: inline-flex;
		align-items: center;
		height: 2.125rem;
		padding: 0 0.875rem;
		border-radius: 999px;
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
		color: var(--color-muted);
		font-size: 0.875rem;
	}
	.chips [aria-current] span {
		background: var(--color-strong);
		box-shadow: none;
		color: var(--color-paper);
		font-weight: 600;
	}
	/* Bar: a 36px search and domain select, as in the page bar of the design. */
	.bar .search {
		flex: 0 1 13.75rem;
		min-width: 8rem;
		height: 2.25rem;
	}
	.bar input {
		font-size: 0.9375rem;
	}
	.domain {
		flex: 0 1 11rem;
		min-width: 0;
		height: 2.25rem;
		color: var(--color-strong);
	}
	.domain select {
		width: 100%;
		min-width: 0;
		align-self: stretch;
		padding: 0 2rem 0 0.75rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.875rem;
		text-overflow: ellipsis;
		appearance: none;
		outline: none;
	}
	.domain select option {
		background: var(--color-paper);
		color: var(--color-strong);
	}
	.domain :global(svg) {
		position: absolute;
		right: 0.75rem;
		pointer-events: none;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
