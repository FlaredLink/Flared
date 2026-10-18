<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	interface Props {
		// True while the app loads the next page, such as SvelteKit's navigating.to !== null.
		active: boolean;
		// True once the load has taken longer than the delay; the shell dims its content with it.
		shown?: boolean;
	}
	let { active, shown = $bindable(false) }: Props = $props();

	// A switch that finishes within this time shows no bar, so a fast switch does not flicker.
	const delayMs = 120;

	$effect(() => {
		if (!active) {
			shown = false;
			return;
		}
		const timer = setTimeout(() => (shown = true), delayMs);
		return () => clearTimeout(timer);
	});
</script>

<!-- The shell sets aria-busy on its content; the bar itself is decoration. -->
<div class="progress" class:shown aria-hidden="true"><span></span></div>

<style>
	.progress {
		position: fixed;
		inset: 0 0 auto;
		z-index: 100;
		height: 2px;
		overflow: hidden;
		pointer-events: none;
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease-out);
	}
	.progress.shown {
		opacity: 1;
	}
	span {
		position: absolute;
		inset: 0 auto 0 0;
		width: 40%;
		border-radius: 0 2px 2px 0;
		background: var(--color-strong);
	}
	/* Under reduced motion the base styles stop the animation, and the bar stays as a still line. */
	.shown span {
		animation: travel 1.1s var(--ease-in-out) infinite;
	}
	@keyframes travel {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}
</style>
