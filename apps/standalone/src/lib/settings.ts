// SPDX-License-Identifier: AGPL-3.0-only
// The Settings layout owns the panel that confirms a recent sign-in. Each section asks for it
// through this context, so the panel sits in one place for every section.
import { getContext, setContext } from 'svelte';

export interface SettingsContext {
	askReauth: () => void;
	// Whether the last sign-in is recent enough for a change that needs it.
	fresh: () => boolean;
}

const key = Symbol('settings');

export function provideSettings(context: SettingsContext): void {
	setContext(key, context);
}

// Call while a section initializes.
export function useSettings(): SettingsContext {
	const context = getContext<SettingsContext | undefined>(key);
	if (!context) throw new Error('A Settings section must render inside the Settings layout.');
	return context;
}
