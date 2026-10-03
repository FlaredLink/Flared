// SPDX-License-Identifier: AGPL-3.0-only
// The flared command. run() takes its input and output as arguments so that tests can drive it.
import { parseArgs } from 'node:util';
import { createClient, FlaredApiError, type FlaredClient } from '@flared/client';
import { defaultQrSize, qrPng, qrSvg } from '@flared/client/qr';
import { normalizeHostname, type Domain } from '@flared/contracts/domains';
import type { ListedLink } from '@flared/contracts/links';
import {
	checkToken,
	configDir,
	deleteConfig,
	readConfig,
	resolveApiUrl,
	resolveToken,
	writeConfig,
	type Env
} from './config';
import { CliError, exitCodeFor, exitCodes, UsageError } from './exit';
import {
	analyticsReport,
	domainDetails,
	domainTable,
	identityReport,
	linkDetails,
	linkTable,
	usageReport
} from './output';
import { cliVersion } from './version';

export interface CliIo {
	stdout(text: string): void;
	stderr(text: string): void;
	env: Env;
	stdinIsTTY: boolean;
	readSecret(question: string): Promise<string>;
	readStdin(): Promise<string>;
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	fetch?: typeof fetch;
}

const optionTypes = {
	json: { type: 'boolean' },
	'api-url': { type: 'string' },
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
	'token-stdin': { type: 'boolean' },
	slug: { type: 'string' },
	title: { type: 'string' },
	'clear-title': { type: 'boolean' },
	destination: { type: 'string' },
	'idempotency-key': { type: 'string' },
	search: { type: 'string' },
	limit: { type: 'string' },
	cursor: { type: 'string' },
	all: { type: 'boolean' },
	format: { type: 'string' },
	out: { type: 'string' },
	from: { type: 'string' },
	to: { type: 'string' },
	domain: { type: 'string' },
	yes: { type: 'boolean' }
} as const;

type Options = {
	[K in keyof typeof optionTypes]?: (typeof optionTypes)[K]['type'] extends 'boolean'
		? boolean
		: string;
};

interface Context {
	args: string[];
	options: Options;
	io: CliIo;
	json: boolean;
	apiUrl: () => Promise<string>;
	client: () => Promise<FlaredClient>;
	print(human: string, data: unknown): void;
}

interface Command {
	usage: string;
	summary: string;
	options: (keyof typeof optionTypes)[];
	args: number;
	run(context: Context): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A link argument is its ID or its slug. A slug must match exactly one link.
async function resolveLink(client: FlaredClient, reference: string): Promise<string> {
	if (uuid.test(reference)) return reference;
	const page = await client.listLinks({ search: reference, limit: 100 });
	const matches = page.links.filter((link) => link.slug === reference);
	if (matches.length === 1) return matches[0].id;
	if (matches.length === 0)
		throw new CliError(`No link with the slug "${reference}".`, exitCodes.notFound, 'NOT_FOUND');
	throw new UsageError(`Several links use the slug "${reference}". Use the link ID.`);
}

// A domain argument is its ID or its hostname. check and remove apply only to the workspace's
// own domains; link create also accepts the platform domains.
async function resolveDomain(
	client: FlaredClient,
	reference: string,
	workspaceOnly: boolean
): Promise<Domain> {
	let hostname: string;
	try {
		hostname = normalizeHostname(reference);
	} catch {
		// Platform hostnames such as flared.link have two labels, which the rule for adding refuses.
		hostname = reference.trim().toLowerCase().replace(/\.$/, '');
	}
	const { domains } = await client.listDomains();
	const match = domains.find(
		(domain) =>
			(domain.id === reference || domain.hostname === hostname) &&
			(!workspaceOnly || domain.kind === 'workspace')
	);
	if (!match)
		throw new CliError(
			`No domain "${reference}" in this workspace. Run flared domain list.`,
			exitCodes.notFound,
			'NOT_FOUND'
		);
	return match;
}

function limitOf(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new UsageError('Use a --limit from 1 to 100.');
	return limit;
}

const commands: Record<string, Command> = {
	login: {
		usage: 'flared login [--token-stdin] [--api-url URL]',
		summary: 'Save an API token after the API accepts it.',
		options: ['token-stdin'],
		args: 0,
		async run({ options, io, json, print }) {
			let token: string;
			if (options['token-stdin']) token = await io.readStdin();
			else if (io.stdinIsTTY) token = await io.readSecret('API token (from Settings): ');
			else throw new UsageError('Pass the token on standard input with --token-stdin.');
			token = checkToken(token);
			const dir = configDir(io.env);
			const apiUrl = resolveApiUrl(options['api-url'], io.env, await readConfig(dir));
			const identity = await createClient({
				baseUrl: apiUrl,
				token,
				fetch: io.fetch,
				userAgent: `flared-cli/${cliVersion}`
			}).me();
			await writeConfig(dir, { apiUrl, token });
			if (io.env.FLARED_TOKEN && !json)
				io.stderr('FLARED_TOKEN is set, so it still takes precedence over the saved token.');
			print(`Signed in. The token is saved in ${dir}.\n\n${identityReport(identity, apiUrl)}`, {
				apiUrl,
				...identity
			});
		}
	},
	logout: {
		usage: 'flared logout',
		summary: 'Delete the saved token. Revoke it in Settings to stop it working.',
		options: [],
		args: 0,
		async run({ io, print }) {
			const dir = configDir(io.env);
			await deleteConfig(dir);
			print('Removed the saved token. It keeps working until you revoke it in Settings.', {
				ok: true
			});
		}
	},
	whoami: {
		usage: 'flared whoami [--api-url URL]',
		summary: 'Show the token in use, its scopes, and the API URL.',
		options: [],
		args: 0,
		async run({ client, apiUrl, print }) {
			const identity = await (await client()).me();
			const url = await apiUrl();
			print(identityReport(identity, url), { apiUrl: url, ...identity });
		}
	},
	'link create': {
		usage:
			'flared link create URL [--slug SLUG] [--title TITLE] [--domain HOSTNAME] [--idempotency-key KEY]',
		summary: 'Create a short link and print its URL. Without --domain, it uses the default domain.',
		options: ['slug', 'title', 'domain', 'idempotency-key'],
		args: 1,
		async run({ args, options, client, print }) {
			const api = await client();
			let domainId: string | undefined;
			if (options.domain !== undefined) {
				const domain = await resolveDomain(api, options.domain, false);
				if (domain.state !== 'active')
					throw new CliError(
						`${domain.hostname} is ${domain.state}. Links can use it once it is active.`,
						exitCodes.rejected,
						'DOMAIN_UNAVAILABLE'
					);
				domainId = domain.id;
			}
			const result = await api.createLink({
				destination: args[0],
				...(domainId ? { domainId } : {}),
				...(options.slug ? { slug: options.slug } : {}),
				...(options.title ? { title: options.title } : {}),
				...(options['idempotency-key'] ? { idempotencyKey: options['idempotency-key'] } : {})
			});
			print(result.link.shortUrl, result);
		}
	},
	'link list': {
		usage: 'flared link list [--search TEXT] [--limit N] [--cursor CURSOR] [--all]',
		summary: 'List links, newest first.',
		options: ['search', 'limit', 'cursor', 'all'],
		args: 0,
		async run({ options, client, print }) {
			const api = await client();
			const limit = limitOf(options.limit);
			const query = { limit, search: options.search, cursor: options.cursor };
			if (!options.all) {
				const page = await api.listLinks(query);
				const more = page.nextCursor ? `\n\nMore links: --cursor ${page.nextCursor}` : '';
				return print(linkTable(page.links) + more, page);
			}
			const links: ListedLink[] = [];
			let cursor = options.cursor;
			// At most 100 pages, so that a broken cursor cannot loop forever.
			for (let page = 0; page < 100; page += 1) {
				const result = await api.listLinks({ ...query, limit: limit ?? 100, cursor });
				links.push(...result.links);
				if (!result.nextCursor) break;
				cursor = result.nextCursor;
			}
			print(linkTable(links), { links });
		}
	},
	'link get': {
		usage: 'flared link get ID_OR_SLUG',
		summary: 'Show one link.',
		options: [],
		args: 1,
		async run({ args, client, print }) {
			const api = await client();
			const link = await api.getLink(await resolveLink(api, args[0]));
			print(linkDetails(link), { link });
		}
	},
	'link update': {
		usage: 'flared link update ID_OR_SLUG [--destination URL] [--title TITLE | --clear-title]',
		summary: 'Change the destination or the title.',
		options: ['destination', 'title', 'clear-title'],
		args: 1,
		async run({ args, options, client, print }) {
			if (options.title !== undefined && options['clear-title'])
				throw new UsageError('Use --title or --clear-title, not both.');
			const change = {
				...(options.destination !== undefined ? { destination: options.destination } : {}),
				...(options.title !== undefined ? { title: options.title } : {}),
				...(options['clear-title'] ? { title: null } : {})
			};
			if (Object.keys(change).length === 0)
				throw new UsageError('Give --destination, --title, or --clear-title.');
			const api = await client();
			const link = await api.updateLink(await resolveLink(api, args[0]), change);
			print(linkDetails(link), { link });
		}
	},
	'link disable': {
		usage: 'flared link disable ID_OR_SLUG',
		summary: 'Stop a link from redirecting. Its slug stays reserved.',
		options: [],
		args: 1,
		async run({ args, client, print }) {
			const api = await client();
			const link = await api.updateLink(await resolveLink(api, args[0]), { enabled: false });
			print(`Disabled ${link.shortUrl}.`, { link });
		}
	},
	'link enable': {
		usage: 'flared link enable ID_OR_SLUG',
		summary: 'Make a disabled link redirect again.',
		options: [],
		args: 1,
		async run({ args, client, print }) {
			const api = await client();
			const link = await api.updateLink(await resolveLink(api, args[0]), { enabled: true });
			print(`Enabled ${link.shortUrl}.`, { link });
		}
	},
	'link qr': {
		usage: 'flared link qr ID_OR_SLUG [--format svg|png] [--out FILE]',
		summary: 'Make a QR code for the short URL. SVG goes to standard output without --out.',
		options: ['format', 'out'],
		args: 1,
		async run({ args, options, io, json, client, print }) {
			const format = options.format ?? 'svg';
			if (format !== 'svg' && format !== 'png') throw new UsageError('Use --format svg or png.');
			if (format === 'png' && !options.out) throw new UsageError('A PNG needs --out FILE.');
			if (json && !options.out) throw new UsageError('With --json, give --out FILE.');
			const api = await client();
			const link = await api.getLink(await resolveLink(api, args[0]));
			// A PNG without --out was refused above.
			if (!options.out) return io.stdout(qrSvg(link.shortUrl, defaultQrSize));
			const data =
				format === 'svg'
					? qrSvg(link.shortUrl, defaultQrSize)
					: await qrPng(link.shortUrl, defaultQrSize);
			await io.writeFile(options.out, data);
			print(`Saved the QR code for ${link.shortUrl} to ${options.out}.`, {
				shortUrl: link.shortUrl,
				format,
				file: options.out
			});
		}
	},
	'domain list': {
		usage: 'flared domain list',
		summary: 'List the domains for links, their status, and the DNS records to create.',
		options: [],
		args: 0,
		async run({ client, print }) {
			const page = await (await client()).listDomains();
			print(domainTable(page), page);
		}
	},
	'domain add': {
		usage: 'flared domain add HOSTNAME',
		summary: 'Add a subdomain you own, such as go.example.com, and print the DNS record to create.',
		options: [],
		args: 1,
		async run({ args, client, print }) {
			const { domain, created } = await (await client()).addDomain(args[0]);
			const intro = created
				? `Added ${domain.hostname}.`
				: `${domain.hostname} is already in this workspace.`;
			print(`${intro}\n\n${domainDetails(domain)}`, { domain, created });
		}
	},
	'domain check': {
		usage: 'flared domain check HOSTNAME_OR_ID',
		summary: 'Check the DNS record and the HTTPS certificate now.',
		options: [],
		args: 1,
		async run({ args, client, print }) {
			const api = await client();
			const domain = await api.checkDomain((await resolveDomain(api, args[0], true)).id);
			print(domainDetails(domain), { domain });
		}
	},
	'domain remove': {
		usage: 'flared domain remove HOSTNAME_OR_ID --yes',
		summary: 'Remove a domain. Its links stop redirecting; adding it again restores them.',
		options: ['yes'],
		args: 1,
		async run({ args, options, client, print }) {
			const api = await client();
			const domain = await resolveDomain(api, args[0], true);
			const count = domain.activeLinks ?? 0;
			const stops = `${count} active ${count === 1 ? 'link' : 'links'}`;
			if (!options.yes)
				throw new UsageError(
					`Removing ${domain.hostname} stops ${stops}. Run again with --yes to remove it.`
				);
			await api.removeDomain(domain.id);
			const restore = count
				? ` ${stops} stopped redirecting. Add the domain again to restore them.`
				: '';
			print(`Removed ${domain.hostname}.${restore}`, {
				removed: true,
				domain: { id: domain.id, hostname: domain.hostname },
				activeLinks: count
			});
		}
	},
	analytics: {
		usage: 'flared analytics ID_OR_SLUG [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
		summary: 'Show clicks by day, country, referrer, and device.',
		options: ['from', 'to'],
		args: 1,
		async run({ args, options, client, print }) {
			const api = await client();
			const link = await api.getLink(await resolveLink(api, args[0]));
			const analytics = await api.getAnalytics(link.id, { from: options.from, to: options.to });
			print(analyticsReport(link, analytics), { analytics });
		}
	},
	usage: {
		usage: 'flared usage',
		summary: 'Show usage against the workspace limits.',
		options: [],
		args: 0,
		async run({ client, print }) {
			const usage = await (await client()).getUsage();
			print(usageReport(usage), { usage });
		}
	}
};

const globalOptions = 'Options for every command: --json, --api-url URL, --help.';

function help(): string {
	return [
		`flared ${cliVersion}: create, edit, and measure Flared short links.`,
		'',
		...Object.values(commands).map((command) => `  ${command.usage}\n      ${command.summary}`),
		'',
		globalOptions,
		'Environment: FLARED_TOKEN (token), FLARED_API_URL (self-hosted API, such as https://links.example.com/v1).',
		'Exit codes: 0 ok, 1 failure, 2 usage, 3 not signed in, 4 not allowed, 5 not found,',
		'6 rejected input, 7 plan limit, 8 rate limited, 9 service unavailable.',
		'Docs: https://flared.page/docs#cli'
	].join('\n');
}

function findCommand(positionals: string[]): { name: string; command: Command; args: string[] } {
	const [first, second, ...rest] = positionals;
	if (first === 'link' || first === 'domain') {
		const name = `${first} ${second ?? ''}`;
		const command = commands[name];
		if (!command) throw new UsageError(`Unknown ${first} command "${second ?? ''}".`);
		return { name, command, args: rest };
	}
	const command = first === undefined ? undefined : commands[first];
	if (!command || first === undefined) throw new UsageError(`Unknown command "${first ?? ''}".`);
	return { name: first, command, args: positionals.slice(1) };
}

function report(io: CliIo, json: boolean, code: string, message: string, requestId: string | null) {
	if (json) io.stderr(JSON.stringify({ error: { code, message, requestId } }));
	else io.stderr(`Error: ${message}${requestId ? ` (request ${requestId})` : ''}`);
}

export async function run(argv: string[], io: CliIo): Promise<number> {
	let json = argv.includes('--json');
	try {
		const parsed = parseArgs({
			args: argv,
			options: optionTypes,
			allowPositionals: true,
			strict: true
		});
		const options = parsed.values as Options;
		json = options.json === true;
		if (options.version) {
			io.stdout(cliVersion);
			return exitCodes.ok;
		}
		if (parsed.positionals.length === 0) {
			if (options.help) {
				io.stdout(help());
				return exitCodes.ok;
			}
			io.stderr(help());
			return exitCodes.usage;
		}
		const { command, args } = findCommand(parsed.positionals);
		if (options.help) {
			io.stdout(`${command.usage}\n${command.summary}\n${globalOptions}`);
			return exitCodes.ok;
		}
		const allowed = new Set<string>(['json', 'api-url', 'help', ...command.options]);
		const extra = Object.keys(options).find((name) => !allowed.has(name));
		if (extra) throw new UsageError(`--${extra} does not apply here. Usage: ${command.usage}`);
		if (args.length !== command.args) throw new UsageError(`Usage: ${command.usage}`);

		let saved: Awaited<ReturnType<typeof readConfig>> | undefined;
		const config = async () => (saved ??= await readConfig(configDir(io.env)));
		const apiUrl = async () => resolveApiUrl(options['api-url'], io.env, await config());
		await command.run({
			args,
			options,
			io,
			json,
			apiUrl,
			async client() {
				return createClient({
					baseUrl: await apiUrl(),
					token: resolveToken(io.env, await config()),
					fetch: io.fetch,
					userAgent: `flared-cli/${cliVersion}`
				});
			},
			print(human, data) {
				io.stdout(json ? JSON.stringify(data, null, 2) : human);
			}
		});
		return exitCodes.ok;
	} catch (error) {
		if (error instanceof FlaredApiError) {
			report(io, json, error.code, error.message, error.requestId);
			return exitCodeFor(error.code);
		}
		if (
			error instanceof UsageError ||
			(error instanceof TypeError &&
				'code' in error &&
				String(error.code).startsWith('ERR_PARSE_ARGS'))
		) {
			report(io, json, 'USAGE', error.message, null);
			if (!json) io.stderr('Run flared --help for the commands.');
			return exitCodes.usage;
		}
		if (error instanceof CliError) {
			report(io, json, error.code, error.message, null);
			return error.exitCode;
		}
		report(io, json, 'CLI_ERROR', 'Something went wrong. Try again.', null);
		return exitCodes.failure;
	}
}
