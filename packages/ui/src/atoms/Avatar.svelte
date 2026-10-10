<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// Up to two initials from a name or an email address.
	let { name, size = 'md' }: { name: string; size?: 'sm' | 'md' } = $props();
	const initials = $derived.by(() => {
		const words = name
			.split('@')[0]
			.split(/[\s._-]+/)
			.filter(Boolean);
		const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?'];
		return letters
			.map((word) => Array.from(word)[0] ?? '')
			.join('')
			.toLocaleUpperCase();
	});
</script>

<span class="avatar {size}" aria-hidden="true">{initials}</span>

<style>
	.avatar {
		display: inline-grid;
		flex: none;
		place-items: center;
		border-radius: 50%;
		background: var(--color-selected);
		color: var(--color-strong);
		font-weight: 650;
		letter-spacing: 0.02em;
	}
	.sm {
		width: 2.25rem;
		height: 2.25rem;
		font-size: 0.8125rem;
	}
	.md {
		width: 2.75rem;
		height: 2.75rem;
		font-size: 0.9375rem;
	}
</style>
