// SPDX-License-Identifier: AGPL-3.0-only
// The saved API URL and token. The file is readable only by its owner (0600 in a 0700
// directory). FLARED_TOKEN and FLARED_API_URL override it, for CI.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultApiUrl, normalizeBaseUrl } from '@flared/client';
import { tokenPrefix } from '@flared/contracts/tokens';
import { CliError, exitCodes, UsageError } from './exit';

export interface SavedConfig {
	apiUrl?: string;
	token?: string;
}

export type Env = Record<string, string | undefined>;

export function configDir(env: Env, platform = process.platform): string {
	if (env.FLARED_CONFIG_DIR) return env.FLARED_CONFIG_DIR;
	if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'flared');
	return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flared');
}

export async function readConfig(dir: string): Promise<SavedConfig> {
	let text: string;
	try {
		text = await readFile(join(dir, 'config.json'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw new CliError(`Cannot read ${join(dir, 'config.json')}.`, exitCodes.failure);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		value = null;
	}
	if (typeof value !== 'object' || value === null)
		throw new CliError(
			`${join(dir, 'config.json')} is not valid. Run flared login again.`,
			exitCodes.failure
		);
	const { apiUrl, token } = value as Record<string, unknown>;
	return {
		...(typeof apiUrl === 'string' ? { apiUrl } : {}),
		...(typeof token === 'string' ? { token } : {})
	};
}

export async function writeConfig(dir: string, config: SavedConfig): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => undefined);
	const file = join(dir, 'config.json');
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
	await chmod(file, 0o600).catch(() => undefined);
}

export async function deleteConfig(dir: string): Promise<void> {
	await rm(join(dir, 'config.json'), { force: true });
}

export function checkToken(token: string): string {
	const value = token.trim();
	if (!value.startsWith(tokenPrefix) || value.length > 128 || /\s/.test(value))
		throw new UsageError(`An API token starts with ${tokenPrefix}. Create one in Settings.`);
	return value;
}

export function resolveApiUrl(option: string | undefined, env: Env, saved: SavedConfig): string {
	const value = option ?? env.FLARED_API_URL ?? saved.apiUrl ?? defaultApiUrl;
	try {
		return normalizeBaseUrl(value);
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}

export function resolveToken(env: Env, saved: SavedConfig): string {
	const token = env.FLARED_TOKEN || saved.token;
	if (!token)
		throw new CliError(
			'Not signed in. Run flared login, or set FLARED_TOKEN.',
			exitCodes.unauthenticated,
			'UNAUTHENTICATED'
		);
	return token;
}
