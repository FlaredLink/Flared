<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { WebhookDelivery } from '@flared/contracts/webhooks';
	import type { BadgeTone } from '../atoms/Badge.svelte';

	// The recent deliveries of one endpoint while the person has them open.
	export type DeliveriesView =
		| { state: 'loading' }
		| { state: 'error'; message: string }
		| { state: 'ready'; deliveries: WebhookDelivery[] };

	export const deliveryStates: Record<
		WebhookDelivery['state'],
		{ label: string; tone: BadgeTone }
	> = {
		pending: { label: 'Waiting', tone: 'neutral' },
		succeeded: { label: 'Delivered', tone: 'positive' },
		failed: { label: 'Failed', tone: 'danger' },
		skipped: { label: 'Skipped', tone: 'warning' }
	};
</script>

<script lang="ts">
	import { deliveryReason } from './client';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';

	interface Props {
		id: string;
		view: DeliveriesView;
		onretry: () => void;
	}
	let { id, view, onretry }: Props = $props();
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	// The answer of the last attempt, or why there was none.
	function outcome(delivery: WebhookDelivery): string {
		if (delivery.errorCode !== null)
			return deliveryReason(delivery.errorCode, delivery.responseStatus);
		if (delivery.responseStatus !== null) {
			const took = delivery.durationMs === null ? '' : ` in ${delivery.durationMs} ms`;
			return `HTTP ${delivery.responseStatus}${took}.`;
		}
		return delivery.attempts === 0 ? 'Not sent yet.' : 'Sending again soon.';
	}
</script>

<div class="deliveries" {id}>
	{#if view.state === 'loading'}
		<p class="note" role="status">Loading deliveries…</p>
	{:else if view.state === 'error'}
		<div class="note">
			<p class="error" role="alert">{view.message}</p>
			<Button size="sm" onclick={onretry}>Try again</Button>
		</div>
	{:else if view.deliveries.length === 0}
		<p class="note">No deliveries yet. Send a test event to try the endpoint.</p>
	{:else}
		<ul aria-label="Recent deliveries">
			{#each view.deliveries as delivery (delivery.id)}
				<li>
					<Badge tone={deliveryStates[delivery.state].tone}
						>{deliveryStates[delivery.state].label}</Badge
					>
					<span class="what">
						<code>{delivery.eventType}</code>
						<time datetime={delivery.lastAttemptAt ?? delivery.createdAt}
							>{times.format(new Date(delivery.lastAttemptAt ?? delivery.createdAt))}</time
						>
					</span>
					<span class="outcome">{outcome(delivery)}</span>
					<span class="attempts"
						>{delivery.attempts === 1 ? '1 attempt' : `${delivery.attempts} attempts`}</span
					>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.deliveries {
		border-top: 1px solid var(--color-rule);
		padding-top: 0.75rem;
	}
	.note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
	}
	ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		container-type: inline-size;
	}
	li {
		display: grid;
		grid-template-columns: 6.5rem minmax(0, 1.2fr) minmax(0, 1.6fr) auto;
		align-items: center;
		gap: 0.4rem 1rem;
		padding: 0.55rem 0;
		color: var(--color-ink);
		font-size: 0.875rem;
	}
	li + li {
		border-top: 1px solid var(--color-rule);
	}
	.what {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	code {
		overflow: hidden;
		color: var(--color-strong);
		font-size: 0.8125rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	time,
	.attempts {
		color: var(--color-lead);
	}
	/* Narrow lists stack each delivery: state and event, then the answer and attempts. */
	@container (max-width: 34rem) {
		li {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.outcome {
			grid-column: 1 / -1;
		}
	}
</style>
