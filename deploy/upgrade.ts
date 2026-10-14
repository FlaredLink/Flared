// SPDX-License-Identifier: AGPL-3.0-only
// The steps of the "Upgrade Flared" workflow (deploy/flared-upgrade.yml) that runs in an
// operator's copy of Flared. It merges a Flared release into the branch flared-upgrade/vX.Y.Z
// and opens one pull request, or one issue when a person must act. With auto mode, it merges a
// clean pull request of a release that is not marked breaking. It uses only the repository's
// own token and never touches Cloudflare. It lives here, not in the workflow file, so each
// upgrade also updates it, and so it can be tested.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const upstreamUrl = 'https://github.com/FlaredLink/Flared.git';
export const upstreamRepository = 'FlaredLink/Flared';
export const branchPrefix = 'flared-upgrade/';
export const issueTitle = 'Flared upgrade needs attention';
// scripts/release.ts writes this line into the tag message of a breaking release.
export const breakingTrailer = 'Flared-Breaking: true';
const tagNamespace = 'refs/flared/tags/';
// A release vX.Y.Z, or a pre-release vX.Y.Z-rc.N. The daily run only takes releases; a
// pre-release merges only when the operator asks for its tag, such as for a test copy.
const versionPattern = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
const guideUrl = 'https://github.com/FlaredLink/Flared/blob/main/docs/self-hosting/upgrade.md';

export interface PullRequest {
	number: number;
	branch: string;
	url: string;
}

// The GitHub calls the workflow makes, on the copy's repository unless named.
export interface GitHub {
	defaultBranch(): Promise<string>;
	// Open pull requests whose branch starts with flared-upgrade/.
	upgradePullRequests(): Promise<PullRequest[]>;
	createPullRequest(change: {
		title: string;
		branch: string;
		base: string;
		body: string;
	}): Promise<PullRequest>;
	updatePullRequest(number: number, change: { title: string; body: string }): Promise<void>;
	closePullRequest(number: number, comment: string): Promise<void>;
	// false when GitHub refuses, such as for branch protection.
	mergePullRequest(number: number): Promise<boolean>;
	// The open issue titled issueTitle, if any.
	openIssue(): Promise<number | null>;
	createIssue(body: string): Promise<number>;
	updateIssue(number: number, body: string): Promise<void>;
	closeIssue(number: number, comment: string): Promise<void>;
	// The notes of a Flared release, or null.
	releaseNotes(tag: string): Promise<string | null>;
}

export interface UpgradeOptions {
	cwd: string;
	github: GitHub;
	upstream?: string;
	// A release tag such as v0.2.0; the newest release when empty.
	tag?: string;
	auto?: boolean;
	committer?: { name: string; email: string };
	log?: (line: string) => void;
}

export type UpgradeResult =
	| { outcome: 'current'; tag: string }
	| { outcome: 'opened' | 'merged'; tag: string; pullRequest: number }
	| { outcome: 'attention'; issue: number };

const actionsBot = {
	name: 'github-actions[bot]',
	email: '41898283+github-actions[bot]@users.noreply.github.com'
};

// Major, minor, patch, and the pre-release number; a release sorts after its pre-releases.
type Version = [number, number, number, number];

function parseVersion(tag: string): Version | null {
	const match = versionPattern.exec(tag);
	if (!match) return null;
	const rc = match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4]);
	return [Number(match[1]), Number(match[2]), Number(match[3]), rc];
}

const isRelease = (tag: string) => parseVersion(tag)?.[3] === Number.POSITIVE_INFINITY;

function compare(a: Version, b: Version): number {
	for (let index = 0; index < 4; index += 1)
		if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	return 0;
}

const none: Version = [0, 0, 0, 0];

class Git {
	constructor(
		private readonly cwd: string,
		private readonly committer: { name: string; email: string }
	) {}

	run(args: string[], allowFailure = false): { ok: boolean; out: string } {
		const result = spawnSync(
			'git',
			[
				'-c',
				`user.name=${this.committer.name}`,
				'-c',
				`user.email=${this.committer.email}`,
				...args
			],
			{ cwd: this.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
		);
		const ok = result.status === 0;
		if (!ok && !allowFailure)
			throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
		return { ok, out: (result.stdout ?? '').trim() };
	}

	out(args: string[]): string {
		return this.run(args).out;
	}

	ok(args: string[]): boolean {
		return this.run(args, true).ok;
	}

	lines(args: string[]): string[] {
		return this.out(args)
			.split('\n')
			.filter((line) => line !== '');
	}
}

const tagRef = (tag: string) => `${tagNamespace}${tag}`;

function readJson(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: null;
	} catch {
		return null;
	}
}

// Deploy on Cloudflare creates a copy as one commit: the release with its own database IDs in
// wrangler.jsonc, the package renamed, and .github/workflows removed. Only such a copy may record
// the release as its starting point; any other difference would be lost by that record.
function startedAt(git: Git, tag: string): boolean {
	const roots = git.lines(['rev-list', '--max-parents=0', 'HEAD']);
	if (roots.length !== 1) return false;
	const changed = git.lines(['diff', '--name-only', tagRef(tag), roots[0]]);
	return changed.every((path) => {
		if (path === 'wrangler.jsonc' || path.startsWith('.github/')) return true;
		if (path !== 'package.json') return false;
		const release = readJson(git.run(['show', `${tagRef(tag)}:package.json`], true).out);
		const copy = readJson(git.run(['show', `${roots[0]}:package.json`], true).out);
		if (!release || !copy) return false;
		delete release.name;
		delete copy.name;
		return JSON.stringify(release) === JSON.stringify(copy);
	});
}

function issueBody(lines: string[]): string {
	return [
		...lines,
		'',
		`The [upgrade guide](${guideUrl}) has the manual steps. This workflow runs again each day and updates this issue; it closes the issue when a pull request opens.`
	].join('\n');
}

async function needsAttention(github: GitHub, lines: string[]): Promise<UpgradeResult> {
	const body = issueBody(lines);
	const open = await github.openIssue();
	if (open !== null) {
		await github.updateIssue(open, body);
		return { outcome: 'attention', issue: open };
	}
	return { outcome: 'attention', issue: await github.createIssue(body) };
}

function limited(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n\n…`;
}

async function pullRequestBody(
	github: GitHub,
	tags: string[],
	breaking: string[],
	migrations: string[],
	auto: boolean
): Promise<string> {
	const target = tags[tags.length - 1];
	const lines = [`This pull request merges Flared ${target} into your copy.`, ''];
	if (!isRelease(target))
		lines.push(
			`**Pre-release:** ${target} is for testing. The workflow merges it only because you asked for it.`,
			''
		);
	if (breaking.length > 0)
		lines.push(
			`**Breaking:** ${breaking.join(', ')} changes how something works. Read the release notes before you merge.${auto ? ' Auto mode leaves this pull request for you.' : ''}`,
			''
		);
	lines.push('**Database changes:**');
	if (migrations.length === 0) lines.push('None.');
	else
		lines.push(
			...migrations.map((path) => `- \`${path}\``),
			'',
			'A database change cannot be undone by deploying older code. Before you merge, note the time for a [Time Travel restore](https://github.com/FlaredLink/Flared/blob/main/docs/self-hosting/backups.md); this workflow does not touch Cloudflare, so it cannot.'
		);
	lines.push(
		'',
		'Merge with **Create a merge commit**. A squash or rebase merge drops the Flared history that the next upgrade needs. After the merge, Workers Builds applies the database changes and then deploys the new Worker.',
		'',
		'## Release notes'
	);
	for (const tag of [...tags].reverse()) {
		const notes = await github.releaseNotes(tag).catch(() => null);
		const link = `https://github.com/${upstreamRepository}/releases/tag/${tag}`;
		lines.push('', `### [${tag}](${link})`, '', notes ? limited(notes.trim(), 8000) : link);
	}
	return limited(lines.join('\n'), 60000);
}

export async function upgrade(options: UpgradeOptions): Promise<UpgradeResult> {
	const { github } = options;
	const log = options.log ?? (() => undefined);
	const git = new Git(options.cwd, options.committer ?? actionsBot);
	const base = git.out(['rev-parse', '--abbrev-ref', 'HEAD']);
	const defaultBranch = await github.defaultBranch();
	if (base !== defaultBranch)
		throw new Error(`Run the workflow on ${defaultBranch}; it started on ${base}.`);

	// Flared's tags go to a namespace of their own, so they never replace a tag of the copy.
	git.out([
		'fetch',
		'--no-tags',
		options.upstream ?? upstreamUrl,
		`+refs/tags/v*:${tagNamespace}v*`
	]);
	const releases = git
		.lines(['for-each-ref', '--format=%(refname:strip=3)', tagNamespace])
		.filter((tag) => parseVersion(tag) !== null)
		.sort((a, b) => compare(parseVersion(a) ?? none, parseVersion(b) ?? none));
	const newest = releases.filter(isRelease).at(-1);
	if (!newest) throw new Error('Flared has no release tags.');
	const target = options.tag || newest;
	const targetVersion = parseVersion(target);
	if (!targetVersion || !releases.includes(target))
		return needsAttention(github, [
			`The workflow was asked for \`${target}\`, which is not a Flared release tag such as \`v0.2.0\` or a pre-release tag such as \`v0.2.0-rc.1\`.`
		]);
	if (git.ok(['merge-base', '--is-ancestor', `${tagRef(target)}^{commit}`, 'HEAD'])) {
		log(`This copy already contains Flared ${target}.`);
		return { outcome: 'current', tag: target };
	}

	// The newest release in the copy's history, or the release it was deployed from.
	let current = [...releases]
		.reverse()
		.find((tag) => git.ok(['merge-base', '--is-ancestor', `${tagRef(tag)}^{commit}`, 'HEAD']));
	let graft = false;
	if (!current) {
		const manifest = readJson(git.run(['show', 'HEAD:package.json'], true).out);
		const version = typeof manifest?.version === 'string' ? `v${manifest.version}` : '';
		if (!releases.includes(version))
			return needsAttention(github, [
				'This copy has no Flared history, and its `package.json` names no Flared release, so the workflow cannot tell which release it came from.',
				'',
				'Do the first upgrade by hand, as the guide describes. Later upgrades then run here.'
			]);
		if (!startedAt(git, version))
			return needsAttention(github, [
				`This copy has no Flared history, and its first commit is not the Flared ${version} release: copies made before 13 October 2026 started from a commit before it.`,
				'',
				'Do the first upgrade by hand with the steps for those copies in the guide. Later upgrades then run here.'
			]);
		const at = parseVersion(version);
		if (at && compare(at, targetVersion) >= 0) {
			log(`This copy came from Flared ${version}, which is not older than ${target}.`);
			return { outcome: 'current', tag: target };
		}
		current = version;
		graft = true;
	}
	const currentVersion = parseVersion(current) ?? none;
	// The releases this upgrade brings, and the target when it is a pre-release.
	const included = releases.filter((tag) => {
		const version = parseVersion(tag);
		return (
			version !== null &&
			(isRelease(tag) || tag === target) &&
			compare(version, currentVersion) > 0 &&
			compare(version, targetVersion) <= 0
		);
	});
	const breaking = included.filter((tag) =>
		git
			.out(['for-each-ref', '--format=%(contents)', tagRef(tag)])
			.split('\n')
			.some((line) => line.trim() === breakingTrailer)
	);

	const branch = `${branchPrefix}${target}`;
	git.out(['checkout', '-B', branch]);
	if (graft)
		git.out([
			'merge',
			'--allow-unrelated-histories',
			'-s',
			'ours',
			'-m',
			`Record that this copy came from Flared ${current}`,
			tagRef(current)
		]);
	git.run(['merge', '--no-ff', '--no-commit', tagRef(target)], true);
	// The copy keeps its own workflows: Deploy removed Flared's, and the repository token may
	// not change workflow files.
	// git restore refuses an unmerged path, so drop every stage, then take HEAD's files back.
	git.out(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.github/workflows']);
	git.run(['checkout', 'HEAD', '--', '.github/workflows'], true);
	git.out(['clean', '-f', '-q', '--', '.github/workflows']);
	const conflicts = git.lines(['diff', '--name-only', '--diff-filter=U']);
	if (conflicts.length > 0) {
		git.run(['merge', '--abort'], true);
		git.out(['checkout', base]);
		git.run(['branch', '-D', branch], true);
		return needsAttention(github, [
			`Flared ${target} does not merge cleanly into this copy. These files changed in both:`,
			'',
			...conflicts.map((path) => `- \`${path}\``),
			'',
			'Merge it by hand and resolve them:',
			'',
			'```sh',
			`git remote add upstream ${upstreamUrl}   # once`,
			'git fetch upstream --tags',
			`git merge ${target}`,
			'```'
		]);
	}
	git.out(['commit', '--no-edit', '-m', `Upgrade to Flared ${target}`]);
	const migrations = git.lines([
		'diff',
		'--name-only',
		'--diff-filter=A',
		`${tagRef(current)}^{commit}`,
		`${tagRef(target)}^{commit}`,
		'--',
		'packages/data/migrations'
	]);
	git.out(['push', '--force', 'origin', `${branch}:refs/heads/${branch}`]);
	git.out(['checkout', base]);

	const title = `Upgrade to Flared ${target}`;
	const body = await pullRequestBody(github, included, breaking, migrations, options.auto ?? false);
	const open = await github.upgradePullRequests();
	const existing = open.find((pull) => pull.branch === branch);
	const pullRequest = existing ?? (await github.createPullRequest({ title, branch, base, body }));
	if (existing) await github.updatePullRequest(existing.number, { title, body });
	for (const older of open.filter((pull) => pull.branch !== branch))
		await github.closePullRequest(older.number, `Replaced by #${pullRequest.number}.`);
	const issue = await github.openIssue();
	if (issue !== null)
		await github.closeIssue(issue, `Pull request #${pullRequest.number} is open.`);
	log(`Pull request #${pullRequest.number}: ${pullRequest.url}`);

	if (options.auto && breaking.length === 0) {
		if (await github.mergePullRequest(pullRequest.number)) {
			log(`Merged #${pullRequest.number}.`);
			return { outcome: 'merged', tag: target, pullRequest: pullRequest.number };
		}
		log('GitHub did not merge it, so the pull request stays open.');
	}
	return { outcome: 'opened', tag: target, pullRequest: pullRequest.number };
}

// The REST API with the workflow's token.
export function restGitHub(
	repository: string,
	token: string,
	api = 'https://api.github.com'
): GitHub {
	async function call(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${api}${path}`, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok) {
			const error = new Error(`GitHub ${method} ${path} answered ${response.status}`);
			Object.assign(error, { status: response.status });
			throw error;
		}
		return response.status === 204 ? null : response.json();
	}
	const field = (value: unknown, name: string): unknown =>
		typeof value === 'object' && value !== null && name in value
			? Object.fromEntries(Object.entries(value))[name]
			: undefined;
	const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
	const repo = `/repos/${repository}`;
	return {
		async defaultBranch() {
			return String(field(await call('GET', repo), 'default_branch'));
		},
		async upgradePullRequests() {
			return list(await call('GET', `${repo}/pulls?state=open&per_page=100`))
				.map((pull) => ({
					number: Number(field(pull, 'number')),
					branch: String(field(field(pull, 'head'), 'ref')),
					url: String(field(pull, 'html_url'))
				}))
				.filter((pull) => pull.branch.startsWith(branchPrefix));
		},
		async createPullRequest({ title, branch, base, body }) {
			const pull = await call('POST', `${repo}/pulls`, { title, head: branch, base, body });
			return {
				number: Number(field(pull, 'number')),
				branch,
				url: String(field(pull, 'html_url'))
			};
		},
		async updatePullRequest(number, change) {
			await call('PATCH', `${repo}/pulls/${number}`, change);
		},
		async closePullRequest(number, comment) {
			await call('POST', `${repo}/issues/${number}/comments`, { body: comment });
			await call('PATCH', `${repo}/pulls/${number}`, { state: 'closed' });
		},
		async mergePullRequest(number) {
			try {
				await call('PUT', `${repo}/pulls/${number}/merge`, { merge_method: 'merge' });
				return true;
			} catch (error) {
				// 405: not mergeable now, 409: the branch moved; the pull request stays for a person.
				const status = field(error, 'status');
				if (status === 405 || status === 409) return false;
				throw error;
			}
		},
		async openIssue() {
			const issues = list(await call('GET', `${repo}/issues?state=open&per_page=100`));
			const issue = issues.find(
				(item) => field(item, 'title') === issueTitle && field(item, 'pull_request') === undefined
			);
			return issue === undefined ? null : Number(field(issue, 'number'));
		},
		async createIssue(body) {
			return Number(
				field(await call('POST', `${repo}/issues`, { title: issueTitle, body }), 'number')
			);
		},
		async updateIssue(number, body) {
			await call('PATCH', `${repo}/issues/${number}`, { body });
		},
		async closeIssue(number, comment) {
			await call('POST', `${repo}/issues/${number}/comments`, { body: comment });
			await call('PATCH', `${repo}/issues/${number}`, { state: 'closed' });
		},
		async releaseNotes(tag) {
			const release = await call('GET', `/repos/${upstreamRepository}/releases/tags/${tag}`);
			const body = field(release, 'body');
			return typeof body === 'string' ? body : null;
		}
	};
}

// bun deploy/upgrade.ts, from the workflow. GitHub Actions sets GITHUB_REPOSITORY and
// GITHUB_API_URL; the workflow passes the token, the tag input, and the auto mode variable.
async function main(): Promise<void> {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN;
	if (!repository || !token) throw new Error('Run this in GitHub Actions with GITHUB_TOKEN set.');
	const result = await upgrade({
		cwd: process.cwd(),
		github: restGitHub(repository, token, process.env.GITHUB_API_URL || undefined),
		tag: process.env.FLARED_TAG?.trim() || undefined,
		auto: process.env.FLARED_AUTO_UPGRADE === 'true',
		log: (line) => console.log(line)
	});
	console.log(JSON.stringify(result));
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
