<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Link, ListedLink } from '@flared/contracts/links';

	interface Props {
		links: ListedLink[];
		// Address of a link's analytics page. Without it, the list shows no analytics link.
		analyticsHref?: (link: Link) => string;
		// URL of the next page, or null on the last page.
		nextHref?: string | null;
		highlightId?: string | null;
	}

	let { links, analyticsHref, nextHref = null, highlightId = null }: Props = $props();
	let status = $state('');
	let copiedId = $state<string | null>(null);

	const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const numbers = new Intl.NumberFormat();

	function clicksText(link: ListedLink): string {
		if (link.clicksLast30Days === null) return 'Clicks unavailable';
		return `${numbers.format(link.clicksLast30Days)} ${link.clicksLast30Days === 1 ? 'click' : 'clicks'}`;
	}

	function display(url: string): string {
		return url.replace(/^https?:\/\//, '');
	}

	async function copy(link: Link) {
		try {
			await navigator.clipboard.writeText(link.shortUrl);
			copiedId = link.id;
			status = `Copied ${display(link.shortUrl)}`;
		} catch {
			copiedId = null;
			status = 'Copy failed. Select the short link and copy it.';
		}
	}
</script>

<section class="link-list" aria-labelledby="link-list-heading">
	<h2 id="link-list-heading">Your links</h2>
	<p class="status" role="status" aria-live="polite">{status}</p>
	{#if links.length === 0}
		<p class="empty">No links yet. Create your first short link above.</p>
	{:else}
		<ul>
			{#each links as link (link.id)}
				<li class:highlight={link.id === highlightId}>
					<div class="main">
						<a class="short" href={link.shortUrl} target="_blank" rel="noopener noreferrer"
							>{display(link.shortUrl)}</a
						>
						{#if !link.enabled}<span class="badge">Disabled</span>{/if}
						{#if link.title}<span class="title">{link.title}</span>{/if}
						<span class="destination" title={link.destination}>{link.destination}</span>
					</div>
					<div class="meta">
						{#if analyticsHref}
							<a
								class="clicks"
								href={analyticsHref(link)}
								title="Clicks in the last 30 days"
								aria-label={`${clicksText(link)} in the last 30 days for ${display(link.shortUrl)}. Open analytics.`}
								>{clicksText(link)}</a
							>
						{:else}
							<span class="clicks" title="Clicks in the last 30 days">{clicksText(link)}</span>
						{/if}
						<time datetime={link.createdAt}>{dates.format(new Date(link.createdAt))}</time>
						<button
							type="button"
							onclick={() => copy(link)}
							aria-label={`Copy ${display(link.shortUrl)}`}
							>{copiedId === link.id ? 'Copied' : 'Copy'}</button
						>
					</div>
				</li>
			{/each}
		</ul>
		{#if nextHref}<a class="more" href={nextHref}>Next page</a>{/if}
	{/if}
</section>

<style>
	.link-list {
		max-width: 44rem;
		margin-top: 1.5rem;
	}
	h2 {
		font-size: 1.05rem;
	}
	.status:empty {
		display: none;
	}
	.status,
	.empty {
		margin-top: 0.5rem;
		color: var(--color-muted, #667085);
		font-size: 0.85rem;
	}
	ul {
		display: grid;
		margin: 0.75rem 0 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-md, 8px);
		background: var(--color-paper, #fff);
	}
	li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.85rem 1rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule, #d0d5dd);
	}
	li.highlight {
		background: var(--color-accent-soft, #fff4ed);
	}
	.main {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.short {
		color: var(--color-strong, #101828);
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.short:hover {
		text-decoration: underline;
	}
	.title {
		color: var(--color-ink, #101828);
		font-size: 0.85rem;
	}
	.destination {
		overflow: hidden;
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		justify-self: start;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--color-disabled, #eaecf0);
		color: var(--color-muted, #667085);
		font-size: 0.75rem;
	}
	.meta {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.75rem;
		color: var(--color-muted, #667085);
		font-size: 0.8rem;
	}
	.clicks {
		color: var(--color-ink, #101828);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		white-space: nowrap;
	}
	a.clicks {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		text-decoration: underline;
		text-decoration-color: var(--color-rule, #d0d5dd);
		text-underline-offset: 3px;
	}
	a.clicks:hover {
		text-decoration-color: currentColor;
	}
	button {
		min-width: 4.5rem;
		min-height: 40px;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--color-rule, #d0d5dd);
		border-radius: var(--radius-sm, 6px);
		background: var(--color-paper, #fff);
		color: var(--color-ink, #101828);
		font-size: 0.8rem;
		font-weight: 600;
	}
	button:hover {
		border-color: var(--color-muted, #667085);
	}
	.more {
		display: inline-block;
		margin-top: 0.75rem;
		color: var(--color-accent-ink, #b42318);
		font-size: 0.85rem;
		font-weight: 600;
	}
	@media (max-width: 40rem) {
		li {
			flex-direction: column;
			gap: 0.5rem;
		}
		.meta {
			justify-content: space-between;
		}
	}
</style>
