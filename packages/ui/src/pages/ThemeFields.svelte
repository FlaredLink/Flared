<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import {
		buttonShapes,
		buttonStyles,
		pageFonts,
		resolveTheme,
		themePreset,
		themePresets,
		type PageFont,
		type PageTheme,
		type ThemeValues
	} from '@flared/contracts/pages';
	import Button from '../atoms/Button.svelte';
	import Select from '../atoms/Select.svelte';
	import SegmentedControl from '../molecules/SegmentedControl.svelte';

	interface Props {
		theme: PageTheme;
	}

	let { theme = $bindable() }: Props = $props();
	const id = $props.id();

	const values = $derived(resolveTheme(theme));
	const preset = $derived(themePreset(theme.id) ?? themePresets[0]);
	const changed = $derived(Object.keys(theme).some((key) => key !== 'id'));

	const fontNames: Record<PageFont, string> = {
		figtree: 'Figtree',
		sans: 'System sans-serif',
		serif: 'Serif',
		mono: 'Monospace'
	};
	const colours = [
		{ key: 'background', label: 'Background' },
		{ key: 'text', label: 'Text' },
		{ key: 'buttonBackground', label: 'Button' },
		{ key: 'buttonText', label: 'Button text' }
	] as const;

	function set<K extends keyof ThemeValues>(key: K, value: ThemeValues[K]) {
		theme = { ...theme, [key]: value };
	}

	// WCAG relative luminance and contrast of two #rrggbb colours.
	function luminance(colour: string): number {
		const channel = (offset: number) => {
			const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
			return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	}
	function contrast(a: string, b: string): number {
		const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (light + 0.05) / (dark + 0.05);
	}
	// An outline button draws its text in the button colour on the page background.
	const lowContrast = $derived(
		contrast(values.text, values.background) < 4.5 ||
			(values.buttonStyle === 'fill'
				? contrast(values.buttonText, values.buttonBackground) < 4.5
				: contrast(values.buttonBackground, values.background) < 4.5)
	);
</script>

<div class="theme">
	<fieldset>
		<legend>Theme</legend>
		<div class="presets">
			{#each themePresets as item (item.id)}
				<label class="preset" class:chosen={item.id === theme.id}>
					<input
						type="radio"
						name="{id}-preset"
						value={item.id}
						checked={item.id === theme.id}
						onchange={() => (theme = { id: item.id })}
					/>
					<span
						class="swatch"
						aria-hidden="true"
						style:background={item.background}
						style:color={item.text}
					>
						<span class="sample-title">Aa</span>
						<span
							class="sample-button"
							style:background={item.buttonStyle === 'fill' ? item.buttonBackground : 'transparent'}
							style:border-color={item.buttonBackground}
							style:border-radius={item.buttonShape === 'pill'
								? '999px'
								: item.buttonShape === 'rounded'
									? '4px'
									: '0'}
						></span>
					</span>
					<span class="name">{item.name}</span>
				</label>
			{/each}
		</div>
		<p class="hint">A new theme replaces your colour, font, and button changes.</p>
	</fieldset>

	<fieldset>
		<legend>Colours</legend>
		<div class="colours">
			{#each colours as colour (colour.key)}
				<label class="colour">
					<input
						type="color"
						value={values[colour.key]}
						oninput={(event) => set(colour.key, event.currentTarget.value.toLowerCase())}
					/>
					<span>{colour.label}</span>
				</label>
			{/each}
		</div>
		{#if lowContrast}
			<p class="warn" role="status">
				Some text is hard to read on these colours. Choose colours with more contrast.
			</p>
		{/if}
	</fieldset>

	<div class="field">
		<label for="{id}-font">Font</label>
		<Select
			id="{id}-font"
			value={values.font}
			onchange={(event) => set('font', event.currentTarget.value as PageFont)}
		>
			{#each pageFonts as font (font)}
				<option value={font}>{fontNames[font]}</option>
			{/each}
		</Select>
	</div>
	<div class="field">
		<span class="label" aria-hidden="true">Button shape</span>
		<SegmentedControl
			options={buttonShapes.map((shape) => ({
				value: shape,
				label: shape === 'square' ? 'Square' : shape === 'rounded' ? 'Rounded' : 'Pill'
			}))}
			value={values.buttonShape}
			name="{id}-shape"
			label="Button shape"
			wide
			onchange={(value) => {
				const shape = buttonShapes.find((item) => item === value);
				if (shape) set('buttonShape', shape);
			}}
		/>
	</div>
	<div class="field">
		<span class="label" aria-hidden="true">Button style</span>
		<SegmentedControl
			options={buttonStyles.map((style) => ({
				value: style,
				label: style === 'fill' ? 'Filled' : 'Outline'
			}))}
			value={values.buttonStyle}
			name="{id}-style"
			label="Button style"
			wide
			onchange={(value) => {
				const style = buttonStyles.find((item) => item === value);
				if (style) set('buttonStyle', style);
			}}
		/>
	</div>
	{#if changed}
		<Button size="sm" variant="ghost" icon="refresh" onclick={() => (theme = { id: theme.id })}
			>Reset to {preset.name}</Button
		>
	{/if}
</div>

<style>
	.theme {
		display: grid;
		gap: 1rem;
	}
	fieldset {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend,
	label,
	.label {
		color: var(--color-strong);
		font-size: 0.875rem;
		font-weight: 500;
	}
	legend {
		margin-bottom: 0.5rem;
		padding: 0;
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(5.25rem, 1fr));
		gap: 0.5rem;
	}
	.preset {
		display: grid;
		gap: 0.375rem;
		justify-items: center;
		padding: 0.375rem;
		border-radius: 0.75rem;
		cursor: pointer;
	}
	.preset input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.preset.chosen {
		background: var(--color-surface);
		box-shadow: var(--shadow-ring);
	}
	.preset:has(input:focus-visible) {
		box-shadow: 0 0 0 2px var(--color-focus);
	}
	.swatch {
		display: grid;
		gap: 0.375rem;
		justify-items: center;
		width: 100%;
		padding: 0.625rem 0.5rem;
		border-radius: 0.5rem;
		box-shadow: inset 0 0 0 1px var(--color-rule);
	}
	.sample-title {
		font-size: 0.875rem;
		font-weight: 700;
		line-height: 1;
	}
	.sample-button {
		display: block;
		width: 80%;
		height: 0.625rem;
		border: 2px solid;
	}
	.name {
		color: var(--color-muted);
		font-size: 0.75rem;
		font-weight: 400;
	}
	.preset.chosen .name {
		color: var(--color-strong);
		font-weight: 500;
	}
	.colours {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.colour {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		font-weight: 400;
		cursor: pointer;
	}
	.colour input {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border: 0;
		border-radius: 0.5rem;
		background: none;
		cursor: pointer;
	}
	.field {
		display: grid;
		gap: 0.375rem;
	}
	.hint {
		color: var(--color-lead);
		font-size: 0.8125rem;
	}
	.warn {
		color: var(--color-warning);
		font-size: 0.875rem;
	}
	@media (min-width: 40rem) {
		.colours {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
