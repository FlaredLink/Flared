<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Usage, UsageWarning } from '@flared/contracts/analytics';
	import Glyph from '../icons/Glyph.svelte';

	// href leads to where the limits can change, such as a plan page. Without it, no link shows.
	let { usage, href }: { usage: Usage; href?: string } = $props();

	const numbers = new Intl.NumberFormat();
	const dates = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC'
	});

	function message({ resource, level }: UsageWarning): string {
		if (resource === 'clicks') {
			const counts = `${numbers.format(usage.clicks)} of ${numbers.format(usage.clickLimit)} clicks`;
			if (level === 80) return `This workspace recorded ${counts} this month.`;
			const missing = usage.unrecordedSince
				? ` ${numbers.format(usage.unrecordedClicks)} clicks since ${dates.format(new Date(usage.unrecordedSince))} UTC are not recorded.`
				: '';
			return `This workspace reached its monthly click limit. Your links keep redirecting, but new clicks are not recorded until next month.${missing}`;
		}
		const { used, limit } = usage[resource];
		const counts = `${numbers.format(used)} of ${numbers.format(limit)}`;
		if (resource === 'links')
			return level === 80
				? `This workspace uses ${counts} active links.`
				: `This workspace uses ${counts} active links. Disable a link before you create or enable another one.`;
		return level === 80
			? `This workspace uses ${counts} custom domains.`
			: `This workspace uses ${counts} custom domains. Remove a domain before you add another one.`;
	}

	const full = $derived(usage.warnings.some((warning) => warning.level === 100));
</script>

{#if usage.warnings.length > 0}
	<section class="usage-banner" class:full aria-labelledby="usage-banner-heading">
		<span class="icon"><Glyph name={full ? 'warning' : 'warningCircle'} size={20} /></span>
		<div class="text">
			<h2 id="usage-banner-heading">
				{full ? 'A workspace limit is full' : 'A workspace limit is almost full'}
			</h2>
			{#each usage.warnings as warning (warning.resource)}<p>{message(warning)}</p>{/each}
		</div>
		{#if href}<a {href}>See plans and usage<Glyph name="arrow" size={16} /></a>{/if}
	</section>
{/if}

<style>
	.usage-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem 0.75rem;
		margin-bottom: 1.5rem;
		padding: 0.75rem 1rem;
		border: 1px solid color-mix(in oklch, var(--color-warning) 35%, transparent);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-warning-soft);
		color: var(--color-ink);
	}
	.full {
		border-color: color-mix(in oklch, var(--color-danger) 35%, transparent);
		background: var(--color-danger-soft);
	}
	.icon {
		display: grid;
		margin-top: 0.1rem;
		color: var(--color-warning);
	}
	.full .icon {
		color: var(--color-danger);
	}
	.text {
		display: grid;
		flex: 1 1 20rem;
		gap: 0.15rem;
		min-width: 0;
	}
	h2 {
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: 0;
	}
	p {
		color: var(--color-ink);
		font-size: 0.875rem;
	}
	a {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.35rem;
		align-self: center;
		color: var(--color-link);
		font-size: 0.875rem;
		font-weight: 500;
	}
	a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
