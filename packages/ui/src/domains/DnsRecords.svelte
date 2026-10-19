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
					<td data-label="Type"><code>{dnsRecord.type}</code></td>
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
	/* Base: each value is its own labelled row, as on a phone. A wide container shows a table. */
	.records {
		border-radius: 0.75rem;
		background: var(--color-surface-2);
		container-type: inline-size;
	}
	table {
		display: block;
		width: 100%;
		border-collapse: collapse;
	}
	thead {
		display: none;
	}
	tbody,
	tr {
		display: block;
	}
	tr + tr {
		border-top: 1px solid var(--color-rule);
	}
	td {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3.25rem;
		padding: 0.25rem 0.25rem 0.25rem 0.75rem;
		color: var(--color-strong);
	}
	td + td {
		border-top: 1px solid var(--color-rule-soft);
	}
	td::before {
		content: attr(data-label);
		flex: none;
		width: 3.5rem;
		color: var(--color-subtle);
		font-size: 0.75rem;
	}
	.cell {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	code {
		flex: 1;
		min-width: 0;
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
	@container (min-width: 30rem) {
		table {
			display: table;
			table-layout: fixed;
		}
		thead {
			display: table-header-group;
		}
		tbody {
			display: table-row-group;
		}
		tr {
			display: table-row;
		}
		th {
			padding: 0.625rem 0.75rem 0;
			color: var(--color-subtle);
			font-size: 0.6875rem;
			font-weight: 500;
			text-align: left;
		}
		th:first-child {
			width: 5.5rem;
		}
		th:nth-child(2) {
			width: 30%;
		}
		td {
			display: table-cell;
			min-height: 0;
			padding: 0.25rem 0.5rem 0.25rem 0.75rem;
			vertical-align: middle;
		}
		td + td {
			border-top: 0;
		}
		td::before {
			content: none;
		}
		tbody tr:last-child td {
			padding-bottom: 0.5rem;
		}
	}
</style>
