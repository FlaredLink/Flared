<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { renderPage, type PageView } from '@flared/contracts/page-render';

	interface Props {
		view: PageView;
	}

	let { view }: Props = $props();

	// The frame reloads on each new document, so typing redraws it after a short pause.
	let html = $state('');
	$effect(() => {
		const next = renderPage(view).html;
		if (!html) {
			html = next;
			return;
		}
		const timer = setTimeout(() => (html = next), 250);
		return () => clearTimeout(timer);
	});
</script>

<figure class="preview">
	<figcaption class="label">Preview</figcaption>
	<div class="phone">
		<!-- An empty sandbox: no script, no form, and no new window, so a link opens nothing. -->
		{#if html}
			<iframe title="Page preview" sandbox="" srcdoc={html}></iframe>
		{/if}
	</div>
</figure>

<style>
	.preview {
		display: grid;
		gap: 0.5rem;
		margin: 0;
	}
	.label {
		color: var(--color-subtle);
		font-size: 0.8125rem;
		font-weight: 500;
	}
	.phone {
		overflow: hidden;
		width: 100%;
		max-width: 22.5rem;
		height: min(42rem, 75vh);
		margin: 0 auto;
		border-radius: 1.75rem;
		background: var(--color-surface-2);
		box-shadow:
			var(--shadow-ring),
			0 0 0 0.375rem var(--color-surface),
			0 0 0 calc(0.375rem + 1px) var(--color-rule);
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}
</style>
