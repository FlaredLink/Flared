<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Usage, UsageWarning } from '@flared/contracts/analytics';

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
		<h2 id="usage-banner-heading">
			{full ? 'A workspace limit is full' : 'A workspace limit is almost full'}
		</h2>
		<ul>
			{#each usage.warnings as warning (warning.resource)}<li>{message(warning)}</li>{/each}
		</ul>
		{#if href}<a {href}>See plans and usage</a>{/if}
	</section>
{/if}

<style>
	.usage-banner {
		display: grid;
		gap: 0.4rem;
		max-width: 44rem;
		margin-bottom: 1.5rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--color-warning, #b54708);
		border-radius: var(--radius-md, 0.75rem);
		background: var(--color-warning-soft, #fffaeb);
		color: var(--color-ink, #101828);
	}
	.usage-banner.full {
		border-color: var(--color-danger, #b42318);
		background: var(--color-danger-soft, #fef3f2);
	}
	h2 {
		font-size: 1rem;
	}
	ul {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.9rem;
	}
	a {
		justify-self: start;
		color: var(--color-strong, #101828);
		font-size: 0.9rem;
		font-weight: 600;
		text-decoration: underline;
	}
</style>
