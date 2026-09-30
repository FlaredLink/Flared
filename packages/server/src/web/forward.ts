// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthService {
	fetch(request: Request): Promise<Response>;
}
export function authResponseHeaders(headers: HeadersInit = {}): Headers {
	const result = new Headers(headers);
	result.set('cache-control', 'no-store');
	result.set('x-robots-tag', 'noindex, nofollow');
	result.set('referrer-policy', 'no-referrer');
	return result;
}
export function finalizeAuthResponse(response: Response): Response {
	const headers = authResponseHeaders(response.headers);
	headers.delete('set-cookie');
	for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
export async function forwardAuthRequest(
	request: Request,
	service: AuthService,
	origin: string,
	sourceIp: string | null
): Promise<Response> {
	const url = new URL(request.url);
	const headers = new Headers();
	for (const name of ['origin', 'cookie', 'content-type', 'accept']) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	if (sourceIp) headers.set('x-flared-source', sourceIp);
	const upstream = new Request(new URL(url.pathname, origin), {
		method: request.method,
		headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
		redirect: 'manual'
	});
	return finalizeAuthResponse(await service.fetch(upstream));
}
