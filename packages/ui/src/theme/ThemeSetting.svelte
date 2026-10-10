<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import { onMount } from 'svelte';
	import SettingRow from '../molecules/SettingRow.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';
	import { applyTheme, savedTheme, type ThemeChoice } from './theme';

	// Unknown until the browser reads the cookie, so the server renders no chosen option.
	let choice = $state<string>('');

	onMount(() => {
		choice = savedTheme();
	});
</script>

<SettingRow icon="monitor" title="Theme" description="Choose how Flared looks on this device.">
	<div class="theme">
		<SegmentedControl
			name="theme"
			label="Theme"
			variant="outline"
			wide
			value={choice}
			options={[
				{ value: 'system', label: 'System', icon: 'monitor' },
				{ value: 'light', label: 'Light', icon: 'sun' },
				{ value: 'dark', label: 'Dark', icon: 'moon' }
			]}
			onchange={(next) => {
				choice = next;
				applyTheme(next as ThemeChoice);
			}}
		/>
		<p>System follows your device settings.</p>
	</div>
</SettingRow>

<style>
	.theme {
		display: grid;
		flex: 1;
		gap: 0.5rem;
		max-width: 38rem;
	}
	p {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
</style>
