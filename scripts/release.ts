// SPDX-License-Identifier: AGPL-3.0-only
// bun run release <version> --notes <file> --summary <text> [--breaking] [--feed <file>]
//   [--remote <name or URL>] [--dry-run]
// Publishes a Flared release from main: the tag vX.Y.Z, the release branch that the Deploy
// button copies, and the GitHub Release with its notes. Bump "version" in package.json in a
// reviewed commit first. --feed writes the update feed that flared.page serves; installations
// that opt in read it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const repository = 'FlaredLink/Flared';
const versionPattern = /^\d+\.\d+\.\d+$/;

interface Options {
	version: string;
	notes: string;
	summary: string;
	breaking: boolean;
	feed: string | null;
	remote: string;
	dryRun: boolean;
}

function fail(message: string): never {
	console.error(`release: ${message}`);
	process.exit(1);
}

function git(args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function parse(argv: string[]): Options {
	const [version, ...rest] = argv;
	if (!version || !versionPattern.test(version)) fail('give the version, such as 0.2.0');
	const value = (name: string): string | null => {
		const at = rest.indexOf(name);
		if (at === -1) return null;
		const next = rest[at + 1];
		if (next === undefined || next.startsWith('--')) fail(`${name} needs a value`);
		return next;
	};
	const notes = value('--notes');
	const summary = value('--summary');
	if (!notes) fail('give --notes with the release notes file');
	if (!summary || summary.length > 280) fail('give --summary of at most 280 characters');
	return {
		version,
		notes,
		summary,
		breaking: rest.includes('--breaking'),
		feed: value('--feed'),
		remote: value('--remote') ?? 'origin',
		dryRun: rest.includes('--dry-run')
	};
}

function newer(a: string, b: string): boolean {
	const [x, y] = [a, b].map((value) => value.split('.').map(Number));
	for (let index = 0; index < 3; index += 1)
		if (x[index] !== y[index]) return (x[index] ?? 0) > (y[index] ?? 0);
	return false;
}

function previousRelease(): string | null {
	const tags = git(['tag', '--list', 'v*'])
		.split('\n')
		.map((tag) => tag.slice(1))
		.filter((tag) => versionPattern.test(tag));
	return tags.reduce<string | null>(
		(latest, tag) => (latest === null || newer(tag, latest) ? tag : latest),
		null
	);
}

const options = parse(process.argv.slice(2));
const tag = `v${options.version}`;

const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
const declared =
	typeof manifest === 'object' && manifest !== null && 'version' in manifest
		? manifest.version
		: null;
if (declared !== options.version)
	fail(`package.json says ${String(declared)}; commit the version bump first`);
if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('run it on main');
if (git(['status', '--porcelain'])) fail('the working tree has changes');
git(['fetch', options.remote, 'main', '--tags']);
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'FETCH_HEAD']))
	fail('main differs from the published main; push or pull first');
if (git(['tag', '--list', tag])) fail(`${tag} exists`);

const previous = previousRelease();
if (previous && !newer(options.version, previous)) fail(`${tag} is not newer than v${previous}`);
// With no earlier release, copies made from main before it may still need every migration.
const migrations = previous
	? git(['diff', '--name-only', `v${previous}`, 'HEAD', '--', 'packages/data/migrations']) !== ''
	: true;

const feed = {
	version: options.version,
	publishedAt: new Date().toISOString(),
	notesUrl: `https://github.com/${repository}/releases/tag/${tag}`,
	summary: options.summary,
	migrations,
	breaking: options.breaking
};

const steps: [string, string[]][] = [
	['git', ['tag', '-a', tag, '-m', `Flared ${options.version}`]],
	['git', ['push', options.remote, tag]],
	// Fast-forward only: the release branch never moves back or sideways.
	['git', ['push', options.remote, 'HEAD:refs/heads/release']],
	[
		'gh',
		[
			'release',
			'create',
			tag,
			'--repo',
			repository,
			'--title',
			`Flared ${options.version}`,
			'--notes-file',
			options.notes,
			'--verify-tag',
			'--latest'
		]
	]
];

for (const [command, args] of steps) {
	console.log(`${options.dryRun ? 'would run' : 'running'}: ${command} ${args.join(' ')}`);
	if (!options.dryRun) execFileSync(command, args, { stdio: 'inherit' });
}

const body = `${JSON.stringify(feed, null, '\t')}\n`;
if (options.feed && !options.dryRun) writeFileSync(options.feed, body);
console.log(options.feed ? `feed (${options.feed}):\n${body}` : `feed:\n${body}`);
