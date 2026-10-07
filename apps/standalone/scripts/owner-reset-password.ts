// SPDX-License-Identifier: AGPL-3.0-only
// bun run owner:reset-password [--local]
// Resets the owner's password through the operator's Wrangler login to the Cloudflare account.
// The password and its hash never appear in arguments, logs, or shell history: the password is
// read without echo and the SQL goes through a private temporary file that is deleted at once.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from 'better-auth/crypto';
import { ownerQuery, passwordHashPattern, resetPasswordSql, userIdPattern } from './reset-sql';

const target = process.argv.includes('--local') ? '--local' : '--remote';

function wrangler(args: string[]): string {
	return execFileSync('wrangler', ['d1', 'execute', 'IDENTITY', target, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

function readOwner(): { id: string; username: string } {
	const output = wrangler(['--json', '--command', ownerQuery]);
	const parsed: unknown = JSON.parse(output);
	const first = Array.isArray(parsed) ? parsed[0] : null;
	const rows: unknown =
		typeof first === 'object' && first !== null && 'results' in first ? first.results : null;
	if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected exactly one owner.');
	const row: unknown = rows[0];
	if (typeof row !== 'object' || row === null) throw new Error('Unexpected owner row.');
	const { id, username, owners, accounts } = Object.fromEntries(Object.entries(row));
	if (owners !== 1 || accounts !== 1)
		throw new Error('Expected exactly one owner with one password account.');
	if (typeof id !== 'string' || !userIdPattern.test(id) || typeof username !== 'string')
		throw new Error('Unexpected owner record.');
	return { id, username };
}

// Reads a line from the terminal without showing it.
function hidden(question: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) return Promise.reject(new Error('Run this command in a terminal.'));
	process.stdout.write(question);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding('utf8');
	return new Promise((resolve, reject) => {
		let value = '';
		const done = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
			process.stdout.write('\n');
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === '\r' || character === '\n') {
					done();
					resolve(value);
					return;
				}
				if (character === '\u0003') {
					done();
					reject(new Error('Cancelled.'));
					return;
				}
				value =
					character === '\u007f' || character === '\b' ? value.slice(0, -1) : value + character;
			}
		};
		stdin.on('data', onData);
	});
}

async function main(): Promise<void> {
	const owner = readOwner();
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await prompt.question(
		`Reset the password of "${owner.username}" in the ${target === '--local' ? 'local' : 'remote'} database? This ends every session, API token, connected app, and passkey. [y/N] `
	);
	prompt.close();
	if (answer.trim().toLowerCase() !== 'y') throw new Error('Cancelled.');
	const password = await hidden('New password (12 to 128 characters): ');
	if (password.length < 12 || password.length > 128)
		throw new Error('The password needs 12 to 128 characters.');
	if ((await hidden('New password again: ')) !== password)
		throw new Error('The passwords do not match.');
	const passwordHash = await hashPassword(password);
	if (!passwordHashPattern.test(passwordHash)) throw new Error('Unexpected hash format.');
	const sql = resetPasswordSql({
		userId: owner.id,
		passwordHash,
		auditId: crypto.randomUUID(),
		now: Date.now()
	});
	const directory = mkdtempSync(join(tmpdir(), 'flared-reset-'));
	const file = join(directory, 'reset.sql');
	try {
		writeFileSync(file, sql, { flag: 'wx', mode: 0o600 });
		try {
			wrangler(['--file', file]);
		} catch {
			// Wrangler's output can echo the SQL, so it is not shown.
			throw new Error(
				'The reset did not finish. Every step is safe to repeat; run the command again.'
			);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	console.log(`The password of "${owner.username}" is reset. Sign in with the new password.`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : 'The reset failed.');
	process.exit(1);
});
