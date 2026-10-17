<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import type { AutomationRun } from '@flared/contracts/automations';
	import type { BadgeTone } from '../atoms/Badge.svelte';

	const runStates: Record<AutomationRun['state'], { label: string; tone: BadgeTone }> = {
		succeeded: { label: 'Ran', tone: 'positive' },
		failed: { label: 'Failed', tone: 'danger' },
		skipped: { label: 'Skipped', tone: 'warning' }
	};
</script>

<script lang="ts">
	import { automationErrorMessage, listAutomationRuns } from './client';
	import { ranLabels, resultText, shortUrlText } from './text';
	import { shownWorkspace } from '../workspace/shown';
	import Badge from '../atoms/Badge.svelte';
	import Button from '../atoms/Button.svelte';

	interface Props {
		// The element's id, for aria-controls on the button that shows the list.
		id: string;
		automationId: string;
		// The path of the /v1 API for this browser, such as "/api/v1".
		apiBase: string;
	}
	let { id, automationId, apiBase }: Props = $props();
	const workspace = shownWorkspace();
	const times = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	type View =
		| { state: 'loading' }
		| { state: 'error'; message: string }
		| { state: 'ready'; runs: AutomationRun[] };
	let view = $state<View>({ state: 'loading' });
	// Each load gets a number, so an answer for an earlier load is dropped.
	let request = 0;

	async function load(automation: string) {
		const current = ++request;
		view = { state: 'loading' };
		const result = await listAutomationRuns(apiBase, automation, workspace());
		if (current !== request) return;
		view = result.ok
			? { state: 'ready', runs: result.value }
			: { state: 'error', message: automationErrorMessage(result.failure) };
	}

	$effect(() => {
		void load(automationId);
	});

	function outcome(run: AutomationRun): string {
		const ran = run.actions.map((action) => ranLabels[action]).join(', ');
		const reason = run.result === null ? '' : resultText(run.result);
		if (run.state === 'skipped') return reason || 'Nothing ran.';
		return [ran ? `${ran}.` : '', reason].filter(Boolean).join(' ');
	}
</script>

<div class="runs" {id}>
	{#if view.state === 'loading'}
		<p class="note" role="status">Loading runs…</p>
	{:else if view.state === 'error'}
		<div class="note">
			<p class="error" role="alert">{view.message}</p>
			<Button size="sm" onclick={() => void load(automationId)}>Try again</Button>
		</div>
	{:else if view.runs.length === 0}
		<p class="note">No runs yet. The automation runs on a link when its trigger is met.</p>
	{:else}
		<ul aria-label="Recent runs">
			{#each view.runs as run (run.id)}
				<li>
					<Badge tone={runStates[run.state].tone}>{runStates[run.state].label}</Badge>
					<span class="what">
						<span class="link">{run.shortUrl ? shortUrlText(run.shortUrl) : 'Deleted link'}</span>
						<time datetime={run.createdAt}>{times.format(new Date(run.createdAt))}</time>
					</span>
					<span class="outcome">{outcome(run)}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.runs {
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
		grid-template-columns: 5.5rem minmax(0, 1fr) minmax(0, 1.4fr);
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
	.link {
		overflow: hidden;
		color: var(--color-strong);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	time {
		color: var(--color-lead);
	}
	/* Narrow lists stack each run: state and link, then what happened. */
	@container (max-width: 34rem) {
		li {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.outcome {
			grid-column: 1 / -1;
		}
	}
</style>
