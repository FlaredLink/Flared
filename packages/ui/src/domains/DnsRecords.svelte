<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import type { Domain } from '@flared/contracts/domains';
	import CopyButton from '../molecules/CopyButton.svelte';

	let { domain }: { domain: Domain } = $props();
</script>

<div class="records">
	<table>
		<caption class="visually-hidden">DNS records for {domain.hostname}</caption>
		<thead>
			<tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Target</th></tr>
		</thead>
		<tbody>
			{#each domain.records as dnsRecord (`${dnsRecord.type}:${dnsRecord.name}`)}
				<tr>
					<td data-label="Type">{dnsRecord.type}</td>
					<td data-label="Name">
						<span class="cell"
							><code>{dnsRecord.name}</code><CopyButton
								text={dnsRecord.name}
								label="Copy name for {domain.hostname}"
								size="sm"
							/></span
						>
					</td>
					<td data-label="Target">
						<span class="cell"
							><code>{dnsRecord.value}</code><CopyButton
								text={dnsRecord.value}
								label="Copy target for {domain.hostname}"
								size="sm"
							/></span
						>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.records {
		border: 1px solid var(--color-rule);
		border-radius: var(--radius-md, 0.625rem);
		background: var(--color-paper);
		overflow: hidden;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9375rem;
	}
	th {
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--color-rule);
		background: var(--color-canvas);
		color: var(--color-lead);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-align: left;
		text-transform: uppercase;
	}
	td {
		padding: 0.5rem 1rem;
		color: var(--color-strong);
		vertical-align: middle;
	}
	th + th,
	td + td {
		border-left: 1px solid var(--color-rule);
	}
	.cell {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
	}
	code {
		overflow-wrap: anywhere;
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* On narrow screens each record becomes a stack of labelled values. */
	@media (max-width: 36rem) {
		thead {
			display: none;
		}
		tr,
		td {
			display: block;
		}
		td + td {
			border-left: 0;
			border-top: 1px solid var(--color-rule);
		}
		td::before {
			content: attr(data-label);
			display: block;
			color: var(--color-lead);
			font-size: 0.75rem;
			font-weight: 600;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
	}
</style>
