// SPDX-License-Identifier: AGPL-3.0-only
// Reads a secret from the terminal without echoing it.
import { CliError, exitCodes } from './exit';

export function promptSecret(question: string): Promise<string> {
	const input = process.stdin;
	return new Promise((resolve, reject) => {
		let value = '';
		process.stderr.write(question);
		input.setRawMode(true);
		input.resume();
		input.setEncoding('utf8');
		const done = (error?: Error) => {
			input.setRawMode(false);
			input.pause();
			input.off('data', onData);
			process.stderr.write('\n');
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === '\r' || character === '\n') return done();
				if (character === '\u0003')
					return done(new CliError('Cancelled.', exitCodes.usage, 'CANCELLED'));
				if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
				else if (character >= ' ') value += character;
			}
		};
		input.on('data', onData);
	});
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	let text = '';
	for await (const chunk of stream) text += chunk.toString();
	return text;
}
