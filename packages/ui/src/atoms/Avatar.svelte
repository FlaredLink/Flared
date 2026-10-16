<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	// A DiceBear Notionists face seeded from a hash of the name or email address. The server
	// render, the wait for the face, and any failure show up to two initials in the same box.
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

	let face = $state<string | null>(null);

	// The face is drawn on the device: only the hash seeds it, and nothing is fetched with it.
	async function drawFace(source: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
		const seed = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');
		const [{ createAvatar }, notionists] = await Promise.all([
			import('@dicebear/core'),
			import('@dicebear/notionists')
		]);
		return createAvatar(notionists, { seed }).toDataUri();
	}

	$effect(() => {
		const source = name.trim().toLowerCase();
		let current = true;
		face = null;
		drawFace(source).then(
			(uri) => {
				if (current) face = uri;
			},
			() => {
				if (current) face = null;
			}
		);
		return () => {
			current = false;
		};
	});
</script>

<span class="avatar {size}" aria-hidden="true">
	{#if face}<img src={face} alt="" onerror={() => (face = null)} />{:else}{initials}{/if}
</span>

<style>
	.avatar {
		display: inline-grid;
		flex: none;
		place-items: center;
		overflow: hidden;
		border-radius: 50%;
		background: var(--color-selected);
		box-shadow: var(--shadow-ring);
		color: var(--color-strong);
		font-weight: 650;
		letter-spacing: 0.02em;
		line-height: 1;
	}
	.avatar img {
		display: block;
		width: 100%;
		height: 100%;
	}
	.sm {
		width: 1.75rem;
		height: 1.75rem;
		font-size: 0.6875rem;
	}
	.md {
		width: 2.75rem;
		height: 2.75rem;
		font-size: 0.9375rem;
	}
</style>
