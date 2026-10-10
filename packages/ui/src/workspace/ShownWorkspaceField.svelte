<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- The workspace the page shows, in a form that posts to a server action. -->
<script lang="ts">
	import { workspaceField } from '@flared/contracts/workspace';
	import { shownWorkspaceId } from './shown';

	const id = shownWorkspaceId();
</script>

{#if id()}<input type="hidden" name={workspaceField} value={id()} />{/if}
