<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Glyph from '../icons/Glyph.svelte';
	import type { Crumb } from './Breadcrumbs.svelte';

	interface Props {
		// The trail to this page. Crumbs other than the title show before it from 48rem.
		crumbs?: Crumb[];
		// The phone back button. Without it, the last crumb with a link is the way back.
		back?: { href: string; label: string };
		title: string;
		// A count beside the title, such as the number of links.
		count?: number;
		lead?: string;
		// A fact or control in the bar, before the actions, such as the settings scope. It renders
		// in the bar from 48rem and under it on a phone, and gets which of the two it is.
		top?: Snippet<['bar' | 'under']>;
		// Actions at the end of the bar.
		aside?: Snippet;
		// Content under the bar, such as status.
		children?: Snippet;
	}
	let { crumbs, back, title, count, lead, top, aside, children }: Props = $props();
	const numbers = new Intl.NumberFormat();
	const parents = $derived((crumbs ?? []).filter((crumb) => crumb.label !== title));
	const backTo = $derived(
		back ??
			[...parents].reverse().find((crumb): crumb is Required<Crumb> => crumb.href !== undefined)
	);
	// The lead and children show at every width; the top snippet moves under the bar on a phone.
	const under = $derived(lead !== undefined || children !== undefined);
	const underPhone = $derived(under || top !== undefined);
</script>

<!-- The bar and the lead are siblings in the page flow, so the bar can stick to the top while the
     page scrolls. A shell places the bar with custom properties (see styles/README.md). -->
<header class="page-header">
	<div
		class="bar"
		data-page-bar
		class:pushed={backTo !== undefined}
		class:end-phone={!underPhone}
		class:end-wide={!under}
	>
		{#if backTo}
			<a class="back" href={backTo.href}><Glyph name="caretLeft" size={20} />{backTo.label}</a>
		{/if}
		{#if parents.length}
			<nav class="crumbs" aria-label="Breadcrumb">
				<ol>
					{#each parents as crumb, index (index)}
						<li>
							{#if crumb.href}<a href={crumb.href}>{crumb.label}</a>{:else}<span>{crumb.label}</span
								>{/if}
						</li>
					{/each}
				</ol>
			</nav>
		{/if}
		<h1>
			<span class="title">{title}</span>{#if count !== undefined}<span class="count"
					>{numbers.format(count)}</span
				>{/if}
		</h1>
		{#if top}<div class="top">{@render top('bar')}</div>{/if}
		{#if aside}<div class="aside">{@render aside()}</div>{/if}
	</div>
	{#if underPhone}
		<div class="under" class:phone-only={!under}>
			{#if top}<div class="top-under">{@render top('under')}</div>{/if}
			{#if lead}<p class="lead">{lead}</p>{/if}
			{#if children}{@render children()}{/if}
		</div>
	{/if}
</header>

<style>
	.page-header {
		display: contents;
	}
	/* Phone: a 52px top bar under the status bar. A pushed screen has a back button and a centred
	   title; a top-level screen has a large title at the start. */
	.bar {
		position: var(--page-bar-position, relative);
		top: 0;
		z-index: var(--z-header);
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-height: calc(3.25rem + env(safe-area-inset-top));
		margin: calc(var(--page-top, 0px) * -1) calc(var(--page-bleed, 0px) * -1) 0;
		padding: env(safe-area-inset-top) var(--page-bleed, 0px) 0;
		background: var(--page-background, var(--color-paper));
	}
	.end-phone {
		margin-bottom: 1rem;
	}
	.back {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.125rem;
		min-height: 2.75rem;
		margin-left: -0.5rem;
		padding: 0 0.625rem 0 0.25rem;
		border-radius: 0.75rem;
		color: var(--color-strong);
		font-size: 1rem;
		font-weight: 500;
	}
	.crumbs,
	.top {
		display: none;
	}
	h1 {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--color-strong);
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.025em;
		line-height: 1.2;
	}
	/* An app's own heading rules, such as an accent on "h1 span", must not reach the title. */
	.title {
		color: var(--color-strong);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pushed h1 {
		position: absolute;
		inset-inline: 6rem;
		justify-content: center;
		font-size: 1.0625rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		pointer-events: none;
	}
	.count {
		flex: none;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--color-surface-2);
		box-shadow: var(--shadow-ring);
		color: var(--color-muted);
		font-size: 0.8125rem;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
		line-height: 1.4;
	}
	.aside {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
		color: var(--color-muted);
		font-size: 0.875rem;
	}
	.under {
		display: grid;
		gap: 0.5rem;
		margin: 0.25rem 0 1.25rem;
	}
	.top-under {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.lead {
		color: var(--color-muted);
		font-size: 0.9375rem;
	}
	/* 48rem and up: one 60px bar with the trail, the title, and the actions over a soft line. */
	@media (min-width: 48rem) {
		.bar {
			gap: 0.625rem;
			min-height: 3.75rem;
			padding-top: 0;
			border-bottom: 1px solid var(--color-rule-soft);
		}
		.end-phone {
			margin-bottom: 0;
		}
		.end-wide {
			margin-bottom: 1.5rem;
		}
		.back,
		.top-under {
			display: none;
		}
		.crumbs {
			display: block;
			flex: none;
		}
		.top {
			display: flex;
			flex: none;
			align-items: center;
			gap: 0.5rem;
		}
		h1,
		.pushed h1 {
			position: static;
			flex: 0 1 auto;
			justify-content: flex-start;
			font-size: 1.0625rem;
			font-weight: 600;
			letter-spacing: -0.01em;
			pointer-events: auto;
		}
		.under {
			margin: 1.25rem 0 1.5rem;
		}
		.phone-only {
			display: none;
		}
	}
	ol {
		display: flex;
		align-items: center;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--color-subtle);
		font-size: 0.9375rem;
	}
	li {
		display: flex;
		align-items: center;
		white-space: nowrap;
	}
	li::after {
		content: '/';
		margin-inline: 0.5rem;
		color: var(--color-faint);
	}
	.crumbs a:hover {
		color: var(--color-strong);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
