// SPDX-License-Identifier: AGPL-3.0-only
// A viewer's colour theme. System follows prefers-color-scheme; Light and Dark set data-mode on
// <html>, which tokens.css reads. The choice is a first-party cookie, so the inline script in
// each app.html applies it before the first paint, also on prerendered pages.
export type ThemeChoice = 'system' | 'light' | 'dark';

export function savedTheme(): ThemeChoice {
	const saved = document.cookie.match(/(?:^|;\s*)theme=(light|dark)(?:;|$)/)?.[1];
	return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function applyTheme(next: ThemeChoice): void {
	const root = document.documentElement;
	const secure = location.protocol === 'https:' ? '; secure' : '';
	if (next === 'system') {
		delete root.dataset.mode;
		document.cookie = `theme=; path=/; max-age=0; samesite=lax${secure}`;
		return;
	}
	root.dataset.mode = next;
	document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax${secure}`;
}
