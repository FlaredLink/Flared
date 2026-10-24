<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Social preview: the title, description, and image that link cards in chat apps and social
networks show instead of the destination's own. The form that holds it needs
enctype="multipart/form-data" for the image. -->
<script lang="ts">
	import TextInput from '../atoms/TextInput.svelte';

	interface Props {
		values: { previewTitle: string; previewDescription: string };
		// Prefix for the field IDs, unique on the page.
		idPrefix: string;
		// The URL of the link's current image. An empty image field then keeps it.
		image?: string | null;
		error?: { message: string; field: string | null } | null;
		// The ID of a message that the form already shows. Without it, the error shows here.
		errorId?: string;
		// Why the workspace cannot set these, such as a plan that lacks them. The fields are then
		// read-only and send nothing, so an edit keeps what the link has; the boxes that remove the
		// texts or the image still work.
		unavailable?: string | null;
	}

	let {
		values,
		idPrefix,
		image = null,
		error = null,
		errorId,
		unavailable = null
	}: Props = $props();

	const fieldNames = ['previewTitle', 'previewDescription', 'previewImage'];
	const off = $derived(Boolean(unavailable));
	const invalid = (field: string) => error?.field === field;
	const describedBy = $derived(errorId ?? `${idPrefix}-preview-error`);
	// A disabled or blocked link serves no image, so the thumbnail can fail to load.
	let thumbnailFailed = $state(false);
	$effect(() => {
		if (image) thumbnailFailed = false;
	});
</script>

<fieldset class="preview" aria-describedby="{idPrefix}-preview-hint">
	<legend>Link card <span class="optional">optional</span></legend>
	<p id="{idPrefix}-preview-hint" class="hint">
		{#if unavailable}{unavailable}{:else}
			What Slack, LinkedIn, X, and other apps show when someone shares the link. Empty fields use
			the destination page.
		{/if}
	</p>
	<div class="field" class:off>
		<label for="{idPrefix}-preview-title">Card title</label>
		<TextInput
			id="{idPrefix}-preview-title"
			name="previewTitle"
			autocomplete="off"
			maxlength={200}
			disabled={off}
			value={values.previewTitle}
			invalid={invalid('previewTitle')}
			aria-describedby={invalid('previewTitle') ? describedBy : undefined}
		/>
	</div>
	<div class="field" class:off>
		<label for="{idPrefix}-preview-description">Card description</label>
		<TextInput
			id="{idPrefix}-preview-description"
			name="previewDescription"
			autocomplete="off"
			maxlength={500}
			disabled={off}
			value={values.previewDescription}
			invalid={invalid('previewDescription')}
			aria-describedby={invalid('previewDescription') ? describedBy : undefined}
		/>
	</div>
	<div class="field" class:off>
		<label for="{idPrefix}-preview-image">Card image</label>
		{#if image && !thumbnailFailed}
			<img
				class="thumbnail"
				src={image}
				alt="Current card"
				width="240"
				height="126"
				loading="lazy"
				onerror={() => (thumbnailFailed = true)}
			/>
		{/if}
		<input
			id="{idPrefix}-preview-image"
			class="file"
			name="previewImage"
			type="file"
			accept="image/png,image/jpeg,image/webp"
			disabled={off}
			aria-invalid={invalid('previewImage') || undefined}
			aria-describedby={invalid('previewImage')
				? `${describedBy} ${idPrefix}-preview-image-hint`
				: `${idPrefix}-preview-image-hint`}
		/>
		<p id="{idPrefix}-preview-image-hint" class="hint">
			PNG, JPEG, or WebP, up to 5 MB. 1200 × 630 pixels looks best.{image
				? ' Choose a file to replace the image.'
				: ''}
		</p>
	</div>
	{#if off && (values.previewTitle || values.previewDescription)}
		<label class="check">
			<input type="checkbox" name="removePreviewText" />
			Remove the card title and description
		</label>
	{/if}
	{#if image}
		<label class="check">
			<input type="checkbox" name="removePreviewImage" />
			Remove the card image
		</label>
	{/if}
	{#if !errorId && error && fieldNames.some(invalid)}
		<p id="{idPrefix}-preview-error" class="error" role="alert">{error.message}</p>
	{/if}
</fieldset>

<style>
	.preview {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.off {
		opacity: 0.6;
	}
	legend {
		padding: 0;
		color: var(--color-strong);
		font-size: 0.9375rem;
		font-weight: 600;
	}
	.optional {
		color: var(--color-lead);
		font-weight: 400;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.875rem;
	}
	.field {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
	}
	.field label {
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.thumbnail {
		width: 100%;
		max-width: 15rem;
		height: auto;
		aspect-ratio: 1200 / 630;
		object-fit: cover;
		border-radius: var(--radius-control, 0.5rem);
		box-shadow: var(--shadow-ring);
		background: var(--color-surface-2);
	}
	.file {
		min-width: 0;
		color: var(--color-strong);
		font: inherit;
		font-size: 0.875rem;
	}
	.file:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 2px;
		border-radius: 0.25rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-strong);
		font-size: 0.875rem;
	}
	.error {
		color: var(--color-danger);
		font-size: 0.875rem;
	}
</style>
