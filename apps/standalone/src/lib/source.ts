// SPDX-License-Identifier: AGPL-3.0-only
// The link to the source of the running version (AGPL section 13): SOURCE_URL at the build's
// commit when the build knows it.
export function sourceLink(sourceUrl: string, commit: string): string {
	return /^[0-9a-f]{7,40}$/.test(commit) && sourceUrl.startsWith('https://github.com/')
		? `${sourceUrl}/tree/${commit}`
		: sourceUrl;
}

export const defaultSourceUrl = 'https://github.com/FlaredLink/Flared';
