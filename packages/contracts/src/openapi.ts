// SPDX-License-Identifier: AGPL-3.0-only
// The OpenAPI 3.1 description of the public /v1 API. It is written by hand from the contracts
// in this package; tests check it against the API's routes and real responses. The session-only
// token management routes for the dashboard are not part of the public API.
import { deviceCategories } from './analytics';
import { errorStatus } from './errors';
import { maxDestinationLength, maxIdempotencyKeyLength, maxTitleLength } from './links';
import { tokenScopes, type TokenScope } from './tokens';

export const openApiVersion = '1.0.0';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dateTime = { type: 'string', format: 'date-time' };
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const count = { type: 'integer', minimum: 0 };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
	type: 'object',
	properties,
	required
});

const schemas = {
	Error: object({
		error: object(
			{
				code: { type: 'string', enum: Object.keys(errorStatus) },
				message: { type: 'string' },
				requestId: { type: 'string' },
				field: { type: 'string', description: 'The input that failed validation.' }
			},
			['code', 'message', 'requestId']
		)
	}),
	Scope: { type: 'string', enum: [...tokenScopes] },
	Link: object({
		id: { type: 'string' },
		domainId: { type: 'string' },
		hostname: { type: 'string' },
		slug: { type: 'string' },
		shortUrl: { type: 'string', format: 'uri' },
		destination: { type: 'string', format: 'uri' },
		title: nullable({ type: 'string' }),
		enabled: { type: 'boolean' },
		createdAt: dateTime,
		updatedAt: dateTime
	}),
	ListedLink: {
		allOf: [
			ref('Link'),
			object({
				clicksLast30Days: {
					...nullable(count),
					description: 'Clicks in the last 30 UTC days; null when analytics are unavailable.'
				}
			})
		]
	},
	LinkPage: object({
		links: { type: 'array', items: ref('ListedLink') },
		nextCursor: nullable({ type: 'string' })
	}),
	CreateLinkInput: object(
		{
			destination: { type: 'string', format: 'uri', maxLength: maxDestinationLength },
			slug: {
				type: 'string',
				pattern: '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$',
				description: 'Omit for a generated slug. Reserved paths are refused.'
			},
			title: { type: 'string', maxLength: maxTitleLength },
			domainId: { type: 'string', description: 'Omit for the default short-link domain.' }
		},
		['destination']
	),
	UpdateLinkInput: {
		...object(
			{
				destination: { type: 'string', format: 'uri', maxLength: maxDestinationLength },
				title: nullable({ type: 'string', maxLength: maxTitleLength }),
				enabled: { type: 'boolean' }
			},
			[]
		),
		minProperties: 1
	},
	DailyClicks: object({ day, clicks: count }),
	DimensionClicks: object({ value: { type: 'string' }, clicks: count }),
	LinkAnalytics: object({
		linkId: { type: 'string' },
		from: day,
		to: day,
		total: count,
		days: { type: 'array', items: ref('DailyClicks') },
		countries: {
			type: 'array',
			items: ref('DimensionClicks'),
			description: 'Two-letter country codes, or "unknown".'
		},
		devices: {
			type: 'array',
			items: ref('DimensionClicks'),
			description: `One of ${deviceCategories.join(', ')}.`
		},
		referrers: {
			type: 'array',
			items: ref('DimensionClicks'),
			description: 'Referrer host names; at most 50 per link and day, the rest under "other".'
		},
		asOf: dateTime
	}),
	Usage: object({
		month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
		clicks: count,
		clickLimit: count,
		asOf: dateTime
	}),
	Identity: {
		oneOf: [
			object({
				kind: { const: 'session' },
				scopes: { type: 'array', items: ref('Scope') }
			}),
			object({
				kind: { const: 'token' },
				scopes: { type: 'array', items: ref('Scope') },
				token: object({
					id: { type: 'string' },
					name: { type: 'string' },
					start: { type: 'string', description: 'The prefix and first characters.' },
					expiresAt: nullable(dateTime)
				})
			})
		]
	}
};

const json = (schema: unknown) => ({ 'application/json': { schema } });
const errorResponse = { description: 'An error. See the code.', content: json(ref('Error')) };
const linkId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

function operation(
	summary: string,
	scope: TokenScope | null,
	responses: Record<string, unknown>,
	extra: Record<string, unknown> = {}
) {
	return {
		summary,
		description: scope ? `Needs the \`${scope}\` scope.` : 'Needs no scope.',
		'x-required-scopes': scope ? [scope] : [],
		...extra,
		responses: { ...responses, default: errorResponse }
	};
}

// The document for an API served at serverUrl, such as https://api.flared.page/v1.
export function openApiDocument(serverUrl: string) {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Flared API',
			version: openApiVersion,
			description:
				'Create and edit short links and read their click analytics. Authenticate with an API token from Settings in the Flared app: `Authorization: Bearer flr_…`. Each token works in one workspace and only for its scopes.',
			license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' }
		},
		servers: [{ url: serverUrl }],
		security: [{ bearerAuth: [] }],
		paths: {
			'/me': {
				get: operation('Describe the calling token', null, {
					'200': { description: 'The credential.', content: json(ref('Identity')) }
				})
			},
			'/links': {
				get: operation(
					'List links, newest first',
					'links:read',
					{ '200': { description: 'A page of links.', content: json(ref('LinkPage')) } },
					{
						parameters: [
							{
								name: 'limit',
								in: 'query',
								schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
							},
							{ name: 'cursor', in: 'query', schema: { type: 'string' } },
							{
								name: 'q',
								in: 'query',
								description: 'Search slugs and titles.',
								schema: { type: 'string', maxLength: 100 }
							}
						]
					}
				),
				post: operation(
					'Create a link',
					'links:write',
					{
						'201': {
							description:
								'The link. A repeated request with the same key and input returns the stored result with `Idempotent-Replayed: true`.',
							content: json(object({ link: ref('Link') }))
						}
					},
					{
						parameters: [
							{
								name: 'Idempotency-Key',
								in: 'header',
								required: true,
								description: 'Kept for 24 hours. Reuse it to retry safely.',
								schema: { type: 'string', minLength: 1, maxLength: maxIdempotencyKeyLength }
							}
						],
						requestBody: { required: true, content: json(ref('CreateLinkInput')) }
					}
				)
			},
			'/links/{id}': {
				get: operation(
					'Read a link',
					'links:read',
					{ '200': { description: 'The link.', content: json(object({ link: ref('Link') })) } },
					{ parameters: [linkId] }
				),
				patch: operation(
					'Edit a link',
					'links:write',
					{
						'200': {
							description: 'The changed link.',
							content: json(object({ link: ref('Link') }))
						}
					},
					{
						parameters: [linkId],
						requestBody: { required: true, content: json(ref('UpdateLinkInput')) }
					}
				)
			},
			'/links/{id}/analytics': {
				get: operation(
					'Read click analytics for a link',
					'analytics:read',
					{
						'200': {
							description: 'UTC daily totals and breakdowns, clamped to the retention period.',
							content: json(object({ analytics: ref('LinkAnalytics') }))
						}
					},
					{
						parameters: [
							linkId,
							{ name: 'from', in: 'query', schema: day },
							{ name: 'to', in: 'query', schema: day }
						]
					}
				)
			},
			'/usage': {
				get: operation('Read this month’s recorded clicks', 'usage:read', {
					'200': {
						description: 'Usage in the current UTC month.',
						content: json(object({ usage: ref('Usage') }))
					}
				})
			},
			'/openapi.json': {
				get: {
					summary: 'This document',
					security: [],
					responses: { '200': { description: 'The OpenAPI document.' } }
				}
			}
		},
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API token (flr_…).' }
			},
			schemas
		}
	};
}
