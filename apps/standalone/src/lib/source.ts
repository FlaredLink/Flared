// SPDX-License-Identifier: AGPL-3.0-only
export const defaultSourceUrl = 'https://github.com/FlaredLink/Flared';

// The link to the source of the running version (AGPL section 13). An operator who sets
// SOURCE_URL publishes their own repository, where the build's commit exists. Without it, the
// source is the Flared release: a copy made by Deploy on Cloudflare has its own commit IDs,
// which do not exist in the Flared repository.
export function sourceLink(sourceUrl: string, commit: string, version: string): string {
	if (sourceUrl === defaultSourceUrl)
		return /^\d+\.\d+\.\d+$/.test(version) ? `${sourceUrl}/tree/v${version}` : sourceUrl;
	return /^[0-9a-f]{7,40}$/.test(commit) && sourceUrl.startsWith('https://github.com/')
		? `${sourceUrl}/tree/${commit}`
		: sourceUrl;
}
