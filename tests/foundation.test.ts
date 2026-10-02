// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import migration from '../packages/data/migrations/identity/0001_auth.sql?raw';
import { describe, expect, it } from 'vitest';
import { createSessionOptions } from '../packages/server/src/auth/options';
import { readPrincipal } from '../packages/server/src/auth/session';
import { createEmailTransport } from '../packages/server/src/email/transport';
import { forwardAuthRequest } from '../packages/server/src/web/forward';

describe('shared authentication boundaries', () => {
	it('configures an absolute host-only secure session', () => {
		const options = createSessionOptions('https://flared.link');
		expect(options.session?.expiresIn).toBe(604800);
		expect(options.session?.freshAge).toBe(600);
		expect(options.session?.disableSessionRefresh).toBe(true);
		expect(options.session?.cookieCache?.enabled).toBe(false);
		expect(options.advanced?.defaultCookieAttributes).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/'
		});
		expect(options.advanced?.crossSubDomainCookies?.enabled).not.toBe(true);
		expect(() => createSessionOptions('https://flared.link/path')).toThrow();
	});
	it('rejects unverified and expired principals without returning tokens', async () => {
		const now = Date.now();
		const reader = {
			async getSession() {
				return {
					user: { id: 'user-1', email: 'user@example.com', emailVerified: false },
					session: { expiresAt: new Date(now + 10000) }
				};
			}
		};
		expect(await readPrincipal(reader, new Headers())).toBeNull();
		const valid = {
			async getSession() {
				return {
					user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
					session: { expiresAt: new Date(now + 10000) }
				};
			}
		};
		expect(await readPrincipal(valid, new Headers())).toEqual({
			user: { id: 'user-1', email: 'user@example.com' },
			expiresAt: new Date(now + 10000).toISOString()
		});
		const expired = {
			async getSession() {
				return {
					user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
					session: { expiresAt: new Date(now - 1) }
				};
			}
		};
		expect(await readPrincipal(expired, new Headers())).toBeNull();
	});
	it('turns provider rejection into a sanitized delivery error', async () => {
		const provider = {
			async send() {
				throw new Error('private-provider-payload-token');
			}
		};
		const transport = createEmailTransport(provider, 'no-reply@flared.link');
		await expect(
			transport.send({
				to: 'user@example.com',
				subject: 'Sign in',
				text: 'code',
				html: '<p>code</p>'
			})
		).rejects.toThrow('Email delivery unavailable');
		try {
			await transport.send({
				to: 'user@example.com',
				subject: 'Sign in',
				text: 'code',
				html: '<p>code</p>'
			});
		} catch (error) {
			expect(String(error)).not.toContain('private-provider');
		}
	});
	it('sends from a display name only when one is configured and rejects header injection', async () => {
		const sent: unknown[] = [];
		const provider = {
			async send(message: { from: unknown }) {
				sent.push(message.from);
			}
		};
		const message = {
			to: 'user@example.com',
			subject: 'Sign in',
			text: 'code',
			html: '<p>code</p>'
		};
		await createEmailTransport(provider, 'no-reply@example.com').send(message);
		await createEmailTransport(provider, 'no-reply@example.com', 'Flared').send(message);
		expect(sent).toEqual([
			'no-reply@example.com',
			{ name: 'Flared', email: 'no-reply@example.com' }
		]);
		for (const name of ['', 'Flared\r\nBcc: x@example.com', 'Flared <x@example.com>', '"Flared"'])
			expect(() => createEmailTransport(provider, 'no-reply@example.com', name)).toThrow(
				'Invalid email sender name'
			);
	});
	it('preserves multiple cookies and rebuilds trusted request provenance', async () => {
		const responseHeaders = new Headers();
		responseHeaders.append('set-cookie', 'first=one; Path=/');
		responseHeaders.append('set-cookie', 'second=two; Path=/');
		let received: Request | undefined;
		const service = {
			async fetch(request: Request) {
				received = request;
				return new Response('{}', { headers: responseHeaders });
			}
		};
		const response = await forwardAuthRequest(
			new Request('https://flared.link/api/auth/session', {
				headers: {
					cookie: 'session=secret',
					'x-flared-source': 'forged',
					'x-forwarded-for': 'forged',
					'cf-connecting-ip': 'forged'
				}
			}),
			service,
			'https://flared.link',
			'192.0.2.1'
		);
		expect(response.headers.getSetCookie()).toEqual(['first=one; Path=/', 'second=two; Path=/']);
		expect(received?.headers.get('x-flared-source')).toBe('192.0.2.1');
		expect(received?.headers.get('x-forwarded-for')).toBeNull();
		expect(received?.headers.get('cf-connecting-ip')).toBeNull();
		expect(received?.headers.get('cookie')).toBe('session=secret');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
	it('rejects duplicate canonical email rows in D1', async () => {
		await env.IDENTITY.exec(
			'DROP TABLE IF EXISTS session; DROP TABLE IF EXISTS account; DROP TABLE IF EXISTS verification; DROP TABLE IF EXISTS user;'
		);
		await env.IDENTITY.exec(migration.replace(/^--.*$/gm, ''));
		await env.IDENTITY.prepare(
			'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)'
		)
			.bind('first', 'First', 'user@example.com')
			.run();
		await expect(
			env.IDENTITY.prepare(
				'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)'
			)
				.bind('second', 'Second', 'user@example.com')
				.run()
		).rejects.toThrow('UNIQUE');
	});
});
