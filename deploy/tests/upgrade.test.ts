// SPDX-License-Identifier: AGPL-3.0-only
// The upgrade workflow's steps on temporary Git repositories: a Flared "upstream" with release
// tags, a copy shaped like one from Deploy on Cloudflare, and the copy's own remote. GitHub is a
// fake that records each call.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { breakingTrailer, issueTitle, upgrade, type GitHub, type PullRequest } from '../upgrade';

const committer = { name: 'Test', email: 'test@example.com' };
const made: string[] = [];

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), 'flared-upgrade-'));
	made.push(path);
	return path;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		'git',
		['-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`, ...args],
		{ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
	).trim();
}

function write(root: string, files: Record<string, string | null>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		if (content === null) rmSync(full, { force: true });
		else {
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
	}
}

function manifest(name: string, version: string): string {
	return `${JSON.stringify({ name, private: true, type: 'module', version }, null, '\t')}\n`;
}

// Flared: v0.1.0, v0.2.0 with a migration and workflow changes, and v0.3.0, which can be breaking.
function upstream(options: { breaking?: boolean } = {}): string {
	const root = directory();
	git(root, 'init', '-q', '-b', 'main');
	const release = (version: string, files: Record<string, string | null>, message = '') => {
		write(root, { ...files, 'package.json': manifest('flared-core', version) });
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', `release ${version}`);
		git(root, 'tag', '-a', `v${version}`, '-m', `Flared ${version}${message}`);
	};
	release('0.1.0', {
		'wrangler.jsonc': '{ "database_id": "00000000" }\n',
		'.github/workflows/check.yml': 'name: Check\n',
		'packages/data/migrations/identity/0001_auth.sql': 'CREATE TABLE a (id TEXT);\n',
		'src/app.ts': 'export const answer = 1;\n'
	});
	release('0.2.0', {
		'.github/workflows/check.yml': 'name: Check v2\n',
		'.github/workflows/release-cli.yml': 'name: Release\n',
		'packages/data/migrations/identity/0002_more.sql': 'CREATE TABLE b (id TEXT);\n',
		'src/app.ts': 'export const answer = 2;\n'
	});
	release(
		'0.3.0',
		{ 'src/app.ts': 'export const answer = 3;\n' },
		options.breaking ? `\n\n${breakingTrailer}` : ''
	);
	return root;
}

// A copy as Deploy on Cloudflare makes it: one commit with the release's files, its own
// database IDs, the package renamed, and no workflows. Its remote is a bare repository.
function copyOf(source: string, tag: string, change: Record<string, string | null> = {}): string {
	const root = directory();
	git(root, 'init', '-q', '-b', 'main');
	execFileSync('sh', ['-c', `git -C "${source}" archive ${tag} | tar -x -C "${root}"`]);
	const version = tag.slice(1);
	write(root, {
		'wrangler.jsonc': '{ "database_id": "real-id" }\n',
		'package.json': manifest('flared', version),
		'.github/workflows/check.yml': null,
		'.github/workflows/release-cli.yml': null,
		...change
	});
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'source repo import');
	const remote = directory();
	git(remote, 'init', '-q', '--bare', '-b', 'main');
	git(root, 'remote', 'add', 'origin', remote);
	git(root, 'push', '-q', 'origin', 'main');
	return root;
}

interface FakeGitHub extends GitHub {
	pulls: (PullRequest & { title: string; body: string; open: boolean; merged: boolean })[];
	issues: { number: number; body: string; open: boolean }[];
	calls: string[];
	refuseMerge: boolean;
}

function fakeGitHub(): FakeGitHub {
	let next = 1;
	const fake: FakeGitHub = {
		pulls: [],
		issues: [],
		calls: [],
		refuseMerge: false,
		async defaultBranch() {
			return 'main';
		},
		async upgradePullRequests() {
			return fake.pulls
				.filter((pull) => pull.open && pull.branch.startsWith('flared-upgrade/'))
				.map(({ number, branch, url }) => ({ number, branch, url }));
		},
		async createPullRequest({ title, branch, body }) {
			fake.calls.push(`create pull ${branch}`);
			const number = next++;
			const url = `https://github.example/pull/${number}`;
			fake.pulls.push({ number, branch, url, title, body, open: true, merged: false });
			return { number, branch, url };
		},
		async updatePullRequest(number, { title, body }) {
			fake.calls.push(`update pull ${number}`);
			const pull = fake.pulls.find((item) => item.number === number);
			if (pull) Object.assign(pull, { title, body });
		},
		async closePullRequest(number) {
			fake.calls.push(`close pull ${number}`);
			const pull = fake.pulls.find((item) => item.number === number);
			if (pull) pull.open = false;
		},
		async mergePullRequest(number) {
			fake.calls.push(`merge pull ${number}`);
			if (fake.refuseMerge) return false;
			const pull = fake.pulls.find((item) => item.number === number);
			if (pull) Object.assign(pull, { open: false, merged: true });
			return true;
		},
		async openIssue() {
			return fake.issues.find((issue) => issue.open)?.number ?? null;
		},
		async createIssue(body) {
			fake.calls.push('create issue');
			const number = next++;
			fake.issues.push({ number, body, open: true });
			return number;
		},
		async updateIssue(number, body) {
			fake.calls.push(`update issue ${number}`);
			const issue = fake.issues.find((item) => item.number === number);
			if (issue) issue.body = body;
		},
		async closeIssue(number) {
			fake.calls.push(`close issue ${number}`);
			const issue = fake.issues.find((item) => item.number === number);
			if (issue) issue.open = false;
		},
		async releaseNotes(tag) {
			return `Notes of ${tag}.`;
		}
	};
	return fake;
}

const remoteOf = (copy: string) => git(copy, 'remote', 'get-url', 'origin');
const remoteBranches = (copy: string) =>
	git(remoteOf(copy), 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
const show = (copy: string, ref: string, path: string) => git(copy, 'show', `${ref}:${path}`);

// What a merge of the pull request with a merge commit does to the copy's main branch.
function mergePullRequest(copy: string, branch: string): void {
	git(copy, 'fetch', '-q', 'origin');
	git(copy, 'merge', '-q', '--ff-only', `origin/${branch}`);
	git(copy, 'push', '-q', 'origin', 'main');
}

afterEach(() => {
	for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('the upgrade workflow', () => {
	it('records the starting release once, merges the newest release, and opens one pull request', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.1.0');
		const github = fakeGitHub();
		const run = () => upgrade({ cwd: copy, github, upstream: source, committer });

		expect(await run()).toEqual({ outcome: 'opened', tag: 'v0.3.0', pullRequest: 1 });
		const branch = 'flared-upgrade/v0.3.0';
		expect(remoteBranches(copy)).toContain(branch);
		const ref = `origin/${branch}`;
		git(copy, 'fetch', '-q', 'origin');
		expect(show(copy, ref, 'src/app.ts')).toBe('export const answer = 3;');
		// The copy's own files stay: database IDs, package name, and no Flared workflows.
		expect(show(copy, ref, 'wrangler.jsonc')).toBe('{ "database_id": "real-id" }');
		expect(JSON.parse(show(copy, ref, 'package.json'))).toMatchObject({
			name: 'flared',
			version: '0.3.0'
		});
		expect(git(copy, 'ls-tree', '-r', '--name-only', ref, '.github')).toBe('');
		expect(git(copy, 'log', '--format=%s', ref)).toContain(
			'Record that this copy came from Flared v0.1.0'
		);
		expect(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
		const [pull] = github.pulls;
		expect(pull).toMatchObject({ title: 'Upgrade to Flared v0.3.0', branch });
		expect(pull.body).toContain('packages/data/migrations/identity/0002_more.sql');
		expect(pull.body).not.toContain('0001_auth.sql');
		expect(pull.body).toContain('Notes of v0.2.0.');
		expect(pull.body).toContain('Create a merge commit');

		// A second run updates the same pull request.
		expect(await run()).toMatchObject({ outcome: 'opened', pullRequest: 1 });
		expect(github.calls.filter((call) => call.startsWith('create'))).toEqual([
			'create pull flared-upgrade/v0.3.0'
		]);
		expect(github.calls).toContain('update pull 1');

		// After the merge the copy contains the release, and later runs graft nothing again.
		mergePullRequest(copy, branch);
		expect(await run()).toEqual({ outcome: 'current', tag: 'v0.3.0' });
		expect(
			git(copy, 'log', '--format=%s', 'main')
				.split('\n')
				.filter((line) => line.startsWith('Record'))
		).toHaveLength(1);
	});

	it('does nothing in a copy deployed from the newest release', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.3.0');
		const github = fakeGitHub();
		expect(await upgrade({ cwd: copy, github, upstream: source, committer })).toEqual({
			outcome: 'current',
			tag: 'v0.3.0'
		});
		expect(github.calls).toEqual([]);
		expect(remoteBranches(copy)).toBe('main');
	});

	it('merges the release it is asked for and replaces an older upgrade pull request', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.1.0');
		const github = fakeGitHub();
		const first = await upgrade({ cwd: copy, github, upstream: source, committer, tag: 'v0.2.0' });
		expect(first).toMatchObject({ outcome: 'opened', tag: 'v0.2.0' });
		git(copy, 'fetch', '-q', 'origin');
		expect(show(copy, 'origin/flared-upgrade/v0.2.0', 'src/app.ts')).toBe(
			'export const answer = 2;'
		);
		const second = await upgrade({ cwd: copy, github, upstream: source, committer });
		expect(second).toMatchObject({ outcome: 'opened', tag: 'v0.3.0', pullRequest: 2 });
		expect(github.calls).toContain('close pull 1');
		const wrong = await upgrade({ cwd: copy, github, upstream: source, committer, tag: 'v9.9' });
		expect(wrong.outcome).toBe('attention');
	});

	it('opens one issue on a conflict and pushes nothing', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.1.0');
		write(copy, { 'src/app.ts': 'export const answer = 42;\n' });
		git(copy, 'commit', '-q', '-am', 'my change');
		const github = fakeGitHub();
		const run = () => upgrade({ cwd: copy, github, upstream: source, committer });

		expect(await run()).toEqual({ outcome: 'attention', issue: 1 });
		expect(github.issues[0].body).toContain('`src/app.ts`');
		expect(github.issues[0].body).toContain('git merge v0.3.0');
		expect(remoteBranches(copy)).toBe('main');
		expect(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
		expect(git(copy, 'status', '--porcelain')).toBe('');
		expect(await run()).toEqual({ outcome: 'attention', issue: 1 });
		expect(github.calls).toEqual(['create issue', 'update issue 1']);
		expect(github.pulls).toHaveLength(0);

		// Once the conflict is gone, the pull request opens and the issue closes.
		write(copy, { 'src/app.ts': 'export const answer = 1;\n' });
		git(copy, 'commit', '-q', '-am', 'undo my change');
		expect(await run()).toMatchObject({ outcome: 'opened' });
		expect(github.issues[0].open).toBe(false);
	});

	it('asks for the first upgrade by hand when the copy did not start at a release', async () => {
		const source = upstream();
		// A copy made from a commit between releases has different files.
		const copy = copyOf(source, 'v0.1.0', { 'src/app.ts': 'export const answer = 0;\n' });
		const github = fakeGitHub();
		const result = await upgrade({ cwd: copy, github, upstream: source, committer });
		expect(result).toEqual({ outcome: 'attention', issue: 1 });
		expect(github.issues[0].body).toContain('first commit is not the Flared v0.1.0 release');
		expect(remoteBranches(copy)).toBe('main');

		const unnamed = copyOf(source, 'v0.1.0', {
			'package.json': `${JSON.stringify({ name: 'flared' })}\n`
		});
		const other = fakeGitHub();
		await upgrade({ cwd: unnamed, github: other, upstream: source, committer });
		expect(other.issues[0].body).toContain('names no Flared release');
	});

	it('merges in auto mode only a clean release that is not breaking', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.1.0');
		const github = fakeGitHub();
		const merged = await upgrade({ cwd: copy, github, upstream: source, committer, auto: true });
		expect(merged).toEqual({ outcome: 'merged', tag: 'v0.3.0', pullRequest: 1 });

		const refused = fakeGitHub();
		refused.refuseMerge = true;
		const another = copyOf(source, 'v0.1.0');
		expect(
			await upgrade({ cwd: another, github: refused, upstream: source, committer, auto: true })
		).toMatchObject({ outcome: 'opened' });

		const breakingSource = upstream({ breaking: true });
		const waiting = copyOf(breakingSource, 'v0.1.0');
		const wait = fakeGitHub();
		const result = await upgrade({
			cwd: waiting,
			github: wait,
			upstream: breakingSource,
			committer,
			auto: true
		});
		expect(result).toMatchObject({ outcome: 'opened', tag: 'v0.3.0' });
		expect(wait.calls.some((call) => call.startsWith('merge'))).toBe(false);
		expect(wait.pulls[0].body).toContain('**Breaking:** v0.3.0');
	});

	it('keeps tags of the copy and refuses another branch', async () => {
		const source = upstream();
		const copy = copyOf(source, 'v0.1.0');
		git(copy, 'tag', 'v0.2.0');
		const github = fakeGitHub();
		await upgrade({ cwd: copy, github, upstream: source, committer });
		expect(git(copy, 'rev-parse', 'v0.2.0^{commit}')).toBe(git(copy, 'rev-parse', 'main~0'));
		git(copy, 'checkout', '-q', '-b', 'feature');
		await expect(upgrade({ cwd: copy, github, upstream: source, committer })).rejects.toThrow(
			'Run the workflow on main'
		);
		expect(issueTitle).toBe('Flared upgrade needs attention');
		expect(git(copy, 'ls-files', '.github')).toBe('');
		expect(readFileSync(join(copy, 'wrangler.jsonc'), 'utf8')).toContain('real-id');
	});
});
