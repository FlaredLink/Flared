#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { run } from './cli';
import { promptSecret, readAll } from './prompt';

process.exitCode = await run(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(`${text}\n`),
	stderr: (text) => process.stderr.write(`${text}\n`),
	env: process.env,
	stdinIsTTY: process.stdin.isTTY === true,
	readSecret: promptSecret,
	readStdin: () => readAll(process.stdin),
	writeFile: (path, data) => writeFile(path, data),
	async openFile(path) {
		const partial = `${path}.partial`;
		const handle = await open(partial, 'w');
		return {
			write: async (text) => {
				await handle.write(text);
			},
			async finish() {
				await handle.close();
				await rename(partial, path);
			},
			async discard() {
				await handle.close().catch(() => {});
				await rm(partial, { force: true });
			}
		};
	}
});
