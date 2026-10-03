// SPDX-License-Identifier: AGPL-3.0-only
// The flared command against a fake API: arguments, exit codes, output, and the saved token.
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { errorStatus, type ErrorCode } from '@flared/contracts/errors';
import { run, type CliIo } from '../src/cli';
import { exitCodes } from '../src/exit';
import { cliVersion } from '../src/version';

const token = `flr_${'a'.repeat(64)}`;
const other = `flr_${'b'.repeat(64)}`;
const allOutput: string[] = [];

const link = (id: string, slug: string) => ({
	id,
	domainId: 'flared-link',
	hostname: 'flared.link',
	slug,
	shortUrl: `https://flared.link/${slug}`,
	destination: 'https://example.com/launch',
	title: null,
	enabled: true,
	createdAt: '2026-10-02T09:00:00.000Z',
	updatedAt: '2026-10-02T09:00:00.000Z'
});
const launch = link('1ca8ae68-76d7-4acf-8599-3d3b5f23c2e7', 'launch');
const twin = link('2ca8ae68-76d7-4acf-8599-3d3b5f23c2e7', 'launch');

interface Seen {
	method: string;
	url: string;
	authorization: string | null;
	body: unknown;
}

// A fake /v1 API. failWith makes every call fail with that error code.
function fakeApi(state: { failWith?: ErrorCode; links?: object[] } = {}) {
	const seen: Seen[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body = request.body ? await request.json() : undefined;
		seen.push({
			method: request.method,
			url: request.url,
			authorization: request.headers.get('authorization'),
			body
		});
		if (state.failWith)
			return Response.json(
				{ error: { code: state.failWith, message: 'Refused.', requestId: 'req-1' } },
				{ status: errorStatus[state.failWith] }
			);
		const path = url.pathname.replace(/^\/v1/, '');
		const links = state.links ?? [{ ...launch, clicksLast30Days: 3 }];
		if (path === '/me')
			return Response.json({
				kind: 'token',
				scopes: ['links:read'],
				token: { id: 't1', name: 'CI', start: token.slice(0, 8), expiresAt: null }
			});
		if (path === '/links' && request.method === 'GET')
			return Response.json({ links, nextCursor: null });
		if (path === '/links' && request.method === 'POST')
			return Response.json({ link: { ...launch, ...(body as object) } }, { status: 201 });
		if (path === `/links/${launch.id}` && request.method === 'GET')
			return Response.json({ link: launch });
		if (path === `/links/${launch.id}` && request.method === 'PATCH')
			return Response.json({ link: { ...launch, ...(body as object) } });
		if (path === `/links/${launch.id}/analytics`)
			return Response.json({
				analytics: {
					linkId: launch.id,
					from: '2026-09-03',
					to: '2026-10-02',
					total: 3,
					days: [{ day: '2026-10-01', clicks: 3 }],
					countries: [{ value: 'US', clicks: 3 }],
					devices: [{ value: 'desktop', clicks: 3 }],
					referrers: [],
					asOf: '2026-10-02T10:00:00.000Z'
				}
			});
		if (path === '/usage')
			return Response.json({
				usage: { month: '2026-10', clicks: 3, clickLimit: 5000, asOf: '2026-10-02T10:00:00.000Z' }
			});
		return Response.json(
			{ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: 'req-2' } },
			{ status: 404 }
		);
	};
	return { fetch, seen };
}

async function freshDir() {
	return mkdtemp(join(tmpdir(), 'flared-cli-'));
}

async function cli(
	argv: string[],
	options: {
		env?: Record<string, string>;
		api?: ReturnType<typeof fakeApi>;
		stdin?: string;
		tty?: boolean;
		dir?: string;
	} = {}
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const files = new Map<string, string | Uint8Array>();
	const dir = options.dir ?? (await freshDir());
	const io: CliIo = {
		stdout: (text) => stdout.push(text),
		stderr: (text) => stderr.push(text),
		env: { FLARED_CONFIG_DIR: dir, ...options.env },
		stdinIsTTY: options.tty ?? false,
		readSecret: async () => options.stdin ?? '',
		readStdin: async () => options.stdin ?? '',
		writeFile: async (path, data) => {
			files.set(path, data);
		},
		fetch: (options.api ?? fakeApi()).fetch
	};
	const code = await run(argv, io);
	allOutput.push(...stdout, ...stderr);
	return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), files, dir };
}

const signedIn = { FLARED_TOKEN: token };

describe('flared CLI', () => {
	it('reports its version and help', async () => {
		const manifest = JSON.parse(
			await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')
		) as { version: string };
		expect(cliVersion).toBe(manifest.version);
		expect((await cli(['--version'])).stdout).toBe(cliVersion);
		expect((await cli(['--help'])).code).toBe(exitCodes.ok);
		const bare = await cli([]);
		expect(bare.code).toBe(exitCodes.usage);
		expect(bare.stderr).toContain('flared link create');
	});

	it('refuses wrong usage with exit code 2', async () => {
		for (const argv of [
			['nope'],
			['link', 'nope'],
			['usage', '--slug', 'x'],
			['link', 'create'],
			['link', 'list', '--limit', '0'],
			['link', 'update', 'launch', '--title', 'x', '--clear-title'],
			['link', 'update', 'launch'],
			['link', 'qr', 'launch', '--format', 'png'],
			['usage', '--unknown'],
			['usage', '--api-url', 'http://api.example/v1']
		]) {
			const result = await cli(argv, { env: signedIn });
			expect(result.code, argv.join(' ')).toBe(exitCodes.usage);
		}
	});

	it('needs a token, and FLARED_TOKEN wins over the saved one', async () => {
		const missing = await cli(['usage', '--json']);
		expect(missing.code).toBe(exitCodes.unauthenticated);
		expect(JSON.parse(missing.stderr)).toEqual({
			error: {
				code: 'UNAUTHENTICATED',
				message: 'Not signed in. Run flared login, or set FLARED_TOKEN.',
				requestId: null
			}
		});

		const dir = await freshDir();
		expect((await cli(['login', '--token-stdin'], { stdin: `${other}\n`, dir })).code).toBe(0);
		const api = fakeApi();
		await cli(['usage'], { dir, api, env: signedIn });
		expect(api.seen[0].authorization).toBe(`Bearer ${token}`);
		const saved = fakeApi();
		await cli(['usage'], { dir, api: saved });
		expect(saved.seen[0].authorization).toBe(`Bearer ${other}`);
	});

	it('saves the token only after the API accepts it, readable only by the owner', async () => {
		const dir = await freshDir();
		const rejected = await cli(['login', '--token-stdin'], {
			stdin: token,
			dir,
			api: fakeApi({ failWith: 'UNAUTHENTICATED' })
		});
		expect(rejected.code).toBe(exitCodes.unauthenticated);
		await expect(stat(join(dir, 'config.json'))).rejects.toThrow();

		expect((await cli(['login', '--token-stdin'], { stdin: 'not-a-token', dir })).code).toBe(
			exitCodes.usage
		);
		expect((await cli(['login'], { dir })).code).toBe(exitCodes.usage);

		const accepted = await cli(['login', '--json'], { stdin: token, tty: true, dir });
		expect(accepted.code).toBe(exitCodes.ok);
		expect(JSON.parse(accepted.stdout)).toMatchObject({
			apiUrl: 'https://api.flared.page/v1',
			kind: 'token'
		});
		const file = join(dir, 'config.json');
		if (process.platform !== 'win32') {
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			expect((await stat(dir)).mode & 0o777).toBe(0o700);
		}
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
			apiUrl: 'https://api.flared.page/v1',
			token
		});

		expect((await cli(['logout'], { dir })).code).toBe(exitCodes.ok);
		await expect(stat(file)).rejects.toThrow();
	});

	it('uses --api-url, then FLARED_API_URL, then the saved URL', async () => {
		const dir = await freshDir();
		await cli(['login', '--token-stdin', '--api-url', 'https://links.example.com/v1/'], {
			stdin: token,
			dir
		});
		const calls = async (argv: string[], env: Record<string, string> = {}) => {
			const api = fakeApi();
			await cli(argv, { dir, api, env });
			return new URL(api.seen[0].url).origin;
		};
		expect(await calls(['usage'])).toBe('https://links.example.com');
		expect(await calls(['usage'], { FLARED_API_URL: 'http://localhost:8787/v1' })).toBe(
			'http://localhost:8787'
		);
		expect(
			await calls(['usage', '--api-url', 'https://other.example/v1'], {
				FLARED_API_URL: 'http://localhost:8787/v1'
			})
		).toBe('https://other.example');
	});

	it('maps every API error code to its documented exit code', async () => {
		const expected: Record<ErrorCode, number> = {
			INVALID_INPUT: 6,
			IDEMPOTENCY_KEY_REQUIRED: 6,
			IDEMPOTENCY_KEY_REUSED: 6,
			SLUG_TAKEN: 6,
			DEFAULT_DOMAIN_UNAVAILABLE: 6,
			DOMAIN_UNAVAILABLE: 6,
			PLAN_LIMIT_REACHED: 7,
			DOMAIN_TAKEN: 6,
			DOMAIN_LIMIT_REACHED: 7,
			DOMAINS_UNAVAILABLE: 9,
			DOMAIN_CHECK_TOO_SOON: 8,
			RATE_LIMITED: 8,
			UNAUTHENTICATED: 3,
			ORIGIN_REJECTED: 4,
			INSUFFICIENT_SCOPE: 4,
			REAUTH_REQUIRED: 4,
			TOKEN_LIMIT_REACHED: 7,
			NO_WORKSPACE: 4,
			WORKSPACE_PENDING: 9,
			NOT_FOUND: 5,
			METHOD_NOT_ALLOWED: 1,
			PAYLOAD_TOO_LARGE: 1,
			UNSUPPORTED_MEDIA_TYPE: 1,
			SERVICE_UNAVAILABLE: 9
		};
		for (const code of Object.keys(errorStatus) as ErrorCode[]) {
			// The client retries 429 and 503; a link edit is never retried, so it fails at once.
			const result = await cli(['link', 'update', launch.id, '--title', 'x', '--json'], {
				env: signedIn,
				api: fakeApi({ failWith: code })
			});
			expect(result.code, code).toBe(expected[code]);
			expect(JSON.parse(result.stderr).error).toEqual({
				code,
				message: 'Refused.',
				requestId: 'req-1'
			});
		}
		const offline = await cli(['link', 'update', launch.id, '--title', 'x'], {
			env: signedIn,
			api: {
				seen: [],
				fetch: async () => {
					throw new TypeError('fetch failed');
				}
			}
		});
		expect(offline.code).toBe(exitCodes.unavailable);
	});

	it('creates a link and prints only its URL, or JSON', async () => {
		const api = fakeApi();
		const created = await cli(
			['link', 'create', 'https://example.com/launch', '--slug', 'launch'],
			{ env: signedIn, api }
		);
		expect(created).toMatchObject({ code: 0, stdout: 'https://flared.link/launch' });
		expect(api.seen[0].body).toEqual({ destination: 'https://example.com/launch', slug: 'launch' });
		const json = await cli(['link', 'create', 'https://example.com/launch', '--json'], {
			env: signedIn
		});
		expect(JSON.parse(json.stdout)).toMatchObject({ replayed: false, link: { slug: 'launch' } });
	});

	it('finds a link by slug and refuses an ambiguous or unknown slug', async () => {
		const shown = await cli(['link', 'get', 'launch'], { env: signedIn });
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain(launch.id);
		const twins = fakeApi({
			links: [
				{ ...launch, clicksLast30Days: 0 },
				{ ...twin, clicksLast30Days: 0 }
			]
		});
		expect((await cli(['link', 'get', 'launch'], { env: signedIn, api: twins })).code).toBe(
			exitCodes.usage
		);
		expect((await cli(['link', 'get', 'missing'], { env: signedIn })).code).toBe(
			exitCodes.notFound
		);
	});

	it('edits, lists, measures, and reports usage', async () => {
		const api = fakeApi();
		expect((await cli(['link', 'disable', 'launch'], { env: signedIn, api })).code).toBe(0);
		expect(api.seen.at(-1)?.body).toEqual({ enabled: false });
		await cli(['link', 'update', launch.id, '--clear-title'], { env: signedIn, api });
		expect(api.seen.at(-1)?.body).toEqual({ title: null });
		expect((await cli(['link', 'list'], { env: signedIn })).stdout).toContain(
			'https://flared.link/launch'
		);
		const report = await cli(['analytics', 'launch'], { env: signedIn });
		expect(report.stdout).toContain('3 clicks from 2026-09-03 to 2026-10-02');
		expect(report.stdout).toContain('US 3');
		expect((await cli(['usage'], { env: signedIn })).stdout).toContain('3 of 5000 clicks');
	});

	it('draws QR codes as SVG or PNG', async () => {
		const svg = await cli(['link', 'qr', 'launch'], { env: signedIn });
		expect(svg.stdout).toMatch(/^<svg/);
		const png = await cli(['link', 'qr', 'launch', '--format', 'png', '--out', 'launch.png'], {
			env: signedIn
		});
		const data = png.files.get('launch.png');
		if (!(data instanceof Uint8Array)) throw new Error('Expected PNG bytes');
		expect([...data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});

afterAll(() => {
	// No command prints a token, whatever happened.
	for (const text of allOutput) {
		expect(text).not.toContain(token.slice(8));
		expect(text).not.toContain(other.slice(8));
	}
});
