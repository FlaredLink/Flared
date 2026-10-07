<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
	import LinkSimple from 'phosphor-svelte/lib/LinkSimple';
	import Globe from 'phosphor-svelte/lib/Globe';
	import GearSix from 'phosphor-svelte/lib/GearSix';
	import SignOut from 'phosphor-svelte/lib/SignOut';
	import List from 'phosphor-svelte/lib/List';
	import X from 'phosphor-svelte/lib/X';
	import Check from 'phosphor-svelte/lib/Check';

	const icons = {
		link: LinkSimple,
		globe: Globe,
		settings: GearSix,
		signOut: SignOut,
		menu: List,
		close: X,
		check: Check
	};
	export type IconName = keyof typeof icons;
</script>

<script lang="ts">
	let { name, size = 20 }: { name: IconName; size?: number } = $props();
	const Component = $derived(icons[name]);
</script>

<Component {size} weight="regular" aria-hidden="true" />
