// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in update check: the release that https://flared.page/releases/latest.json names, and
// what the app shows about it. The feed is written by scripts/release.ts.

export interface Release {
	version: string;
	publishedAt: string;
	notesUrl: string;
	summary: string;
	migrations: boolean;
	breaking: boolean;
}

export interface UpdateState {
	enabled: boolean;
	// The last check that read a valid feed, and the last failed check after it.
	checkedAt: number | null;
	failedAt: number | null;
	latest: Release | null;
}

export const offState: UpdateState = {
	enabled: false,
	checkedAt: null,
	failedAt: null,
	latest: null
};

const versionPattern = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const notesPrefix = 'https://github.com/FlaredLink/Flared/releases/';

function fields(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

// Strict on the fields the app shows; later fields are ignored. The notes link must stay on the
// Flared releases page, so a changed feed cannot send the owner to another site.
export function parseRelease(value: unknown): Release | null {
	const body = fields(value);
	if (!body) return null;
	const { version, publishedAt, notesUrl, summary, migrations, breaking } = body;
	if (typeof version !== 'string' || !versionPattern.test(version)) return null;
	if (
		typeof publishedAt !== 'string' ||
		publishedAt.length > 40 ||
		Number.isNaN(Date.parse(publishedAt))
	)
		return null;
	if (
		typeof notesUrl !== 'string' ||
		notesUrl.length > 512 ||
		!notesUrl.startsWith(notesPrefix) ||
		/\s/.test(notesUrl)
	)
		return null;
	if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 280) return null;
	if (typeof migrations !== 'boolean' || typeof breaking !== 'boolean') return null;
	return { version, publishedAt, notesUrl, summary, migrations, breaking };
}

// Whether a is a later X.Y.Z than b. A build that names no version is older than any release.
export function newerVersion(a: string, b: string): boolean {
	const x = versionPattern.exec(a);
	if (!x) return false;
	const y = versionPattern.exec(b);
	if (!y) return true;
	for (let index = 1; index <= 3; index += 1) {
		const [left, right] = [Number(x[index]), Number(y[index])];
		if (left !== right) return left > right;
	}
	return false;
}

// The release to offer, if the check is on and found one later than this build.
export function availableRelease(state: UpdateState | null, current: string): Release | null {
	if (!state?.enabled || !state.latest) return null;
	return newerVersion(state.latest.version, current) ? state.latest : null;
}

export function toUpdateState(value: unknown): UpdateState | null {
	const body = fields(value);
	if (!body || typeof body.enabled !== 'boolean') return null;
	const time = (field: unknown) =>
		typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : null;
	return {
		enabled: body.enabled,
		checkedAt: time(body.checkedAt),
		failedAt: time(body.failedAt),
		latest: body.latest === null ? null : parseRelease(body.latest)
	};
}

// The operator's copy as owner/name, from what the owner types or a GitHub URL; null otherwise.
export function parseRepository(value: string): string | null {
	const name = value
		.trim()
		.replace(/^https:\/\/github\.com\//, '')
		.replace(/\/$/, '')
		.replace(/\.git$/, '');
	return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(name) &&
		!/\/\.{1,2}$/.test(name)
		? name
		: null;
}

export const workflowPath = '.github/workflows/flared-upgrade.yml';

// GitHub's pages for the one-time workflow setup. The new-file page opens with the path and
// content filled in, on main, the branch Deploy on Cloudflare creates; the owner commits it.
export function workflowLinks(repository: string, workflow: string) {
	const base = `https://github.com/${repository}`;
	return {
		file: `${base}/new/main?filename=${encodeURIComponent(workflowPath)}&value=${encodeURIComponent(workflow)}`,
		actions: `${base}/settings/actions`,
		variable: `${base}/settings/variables/actions/new`
	};
}
