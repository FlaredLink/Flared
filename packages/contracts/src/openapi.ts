// SPDX-License-Identifier: AGPL-3.0-only
// The OpenAPI 3.1 description of the public /v1 API. It is written by hand from the contracts
// in this package; tests check it against the API's routes and real responses. The session-only
// token management routes for the dashboard are not part of the public API.
import { browserFamilies, deviceCategories, osFamilies } from './analytics';
import { domainFailures, domainStates } from './domains';
import { exportAnalyticsPageSize, exportDimensions, exportLinkPageSize } from './export';
import { errorStatus } from './errors';
import {
	blockReasons,
	maxDestinationLength,
	maxIdempotencyKeyLength,
	maxTitleLength,
	recentClickDays
} from './links';
import { tokenScopes, type TokenScope } from './tokens';

// Duplicated from the client's QR module, which this package cannot import.
const qrSizes = { minimum: 128, maximum: 2048, default: 512 };

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
		blocked: {
			...nullable(object({ reason: { type: 'string', enum: [...blockReasons] } })),
			description:
				'Set while Flared blocks the link for abuse. A blocked link does not redirect and cannot be edited or turned on.'
		},
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
				},
				dailyClicksLast30Days: {
					...nullable({
						type: 'array',
						items: count,
						minItems: recentClickDays,
						maxItems: recentClickDays
					}),
					description:
						'Clicks on each of the last 30 UTC days, oldest first, ending today; null when analytics are unavailable.'
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
		browsers: {
			type: 'array',
			items: ref('DimensionClicks'),
			description: `One of ${browserFamilies.join(', ')}. Clicks recorded before browser recording started have no entry, so the sum can be less than total.`
		},
		operatingSystems: {
			type: 'array',
			items: ref('DimensionClicks'),
			description: `One of ${osFamilies.join(', ')}. Clicks recorded before OS recording started have no entry, so the sum can be less than total.`
		},
		asOf: dateTime
	}),
	LimitUsage: object({ used: count, limit: count }),
	UsageWarning: object({
		resource: { type: 'string', enum: ['clicks', 'links', 'domains'] },
		level: {
			type: 'integer',
			enum: [80, 100],
			description: 'The percentage of the limit reached.'
		}
	}),
	Usage: object({
		month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
		clicks: { ...count, description: 'Clicks recorded this UTC month.' },
		clickLimit: { ...count, description: 'Clicks that can be recorded each UTC month.' },
		unrecordedClicks: {
			...count,
			description: 'Clicks this month after the allowance was full. Links kept redirecting.'
		},
		unrecordedSince: nullable({
			...dateTime,
			description: 'When the first click this month was not recorded.'
		}),
		links: { ...ref('LimitUsage'), description: 'Active links and the active link limit.' },
		domains: {
			...ref('LimitUsage'),
			description: 'Custom domains in use and the custom domain limit.'
		},
		retentionDays: { ...count, description: 'Days of click history kept.' },
		warnings: {
			type: 'array',
			items: ref('UsageWarning'),
			description: 'Each limit at 80% or more.'
		},
		asOf: dateTime
	}),
	ExportLinkPage: object({
		links: { type: 'array', items: ref('Link'), maxItems: exportLinkPageSize },
		nextCursor: nullable({ type: 'string' })
	}),
	ExportDailyTotal: object({ linkId: { type: 'string' }, day, clicks: count }),
	ExportDailyDimension: object({
		linkId: { type: 'string' },
		day,
		dimension: { type: 'string', enum: [...exportDimensions] },
		value: { type: 'string' },
		clicks: count
	}),
	ExportTotalsPage: object({
		from: { ...day, description: 'The first retained UTC day.' },
		retentionDays: count,
		rows: { type: 'array', items: ref('ExportDailyTotal'), maxItems: exportAnalyticsPageSize },
		nextCursor: nullable({ type: 'string' })
	}),
	ExportDimensionsPage: object({
		from: { ...day, description: 'The first retained UTC day.' },
		retentionDays: count,
		rows: {
			type: 'array',
			items: ref('ExportDailyDimension'),
			maxItems: exportAnalyticsPageSize
		},
		nextCursor: nullable({ type: 'string' })
	}),
	Domain: object({
		id: { type: 'string' },
		hostname: { type: 'string' },
		kind: {
			type: 'string',
			enum: ['platform', 'workspace'],
			description: 'platform: provided for every workspace. workspace: added by yours.'
		},
		state: {
			type: 'string',
			enum: [...domainStates],
			description: 'Only an active domain serves links.'
		},
		isDefault: { type: 'boolean', description: 'Used for links created without a domain.' },
		records: {
			type: 'array',
			items: object({
				type: { const: 'CNAME' },
				name: { type: 'string' },
				value: { type: 'string' }
			}),
			description: 'The DNS records to create. Empty for platform domains.'
		},
		error: nullable(
			object({ code: { type: 'string', enum: [...domainFailures] }, message: { type: 'string' } })
		),
		activeLinks: {
			...nullable(count),
			description: 'Active links that stop when the domain is removed; null for platform domains.'
		},
		createdAt: dateTime,
		activatedAt: nullable(dateTime)
	}),
	DomainPage: object({
		domains: { type: 'array', items: ref('Domain') },
		used: { ...count, description: 'Workspace domains that count against the limit.' },
		limit: count
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
const domainId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const cursor = {
	name: 'cursor',
	in: 'query',
	description: 'The nextCursor of the previous page.',
	schema: { type: 'string' }
};
const domainResponse = (description: string) => ({
	description,
	content: json(object({ domain: ref('Domain') }))
});

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
			'/links/{id}/qr': {
				get: operation(
					'Download a QR code for a link',
					'links:read',
					{
						'200': {
							description: 'A QR code of the short URL, black on white.',
							content: {
								'image/svg+xml': { schema: { type: 'string' } },
								'image/png': { schema: { type: 'string', format: 'binary' } }
							}
						}
					},
					{
						parameters: [
							linkId,
							{
								name: 'format',
								in: 'query',
								schema: { type: 'string', enum: ['svg', 'png'], default: 'svg' }
							},
							{
								name: 'size',
								in: 'query',
								description: 'The image width and height in pixels.',
								schema: { type: 'integer', ...qrSizes }
							},
							{
								name: 'download',
								in: 'query',
								description: 'Send 1 to download the image as a file.',
								schema: { type: 'string', enum: ['1'] }
							}
						]
					}
				)
			},
			'/domains': {
				get: operation('List domains you can use', 'domains:read', {
					'200': {
						description: 'Platform domains, then your workspace domains.',
						content: json(ref('DomainPage'))
					}
				}),
				post: operation(
					'Add a custom domain',
					'domains:write',
					{
						'201': domainResponse('The domain. Create its DNS records next.'),
						'200': domainResponse('Your workspace already has this domain.')
					},
					{
						requestBody: {
							required: true,
							content: json(
								object({
									hostname: {
										type: 'string',
										description: 'A subdomain such as go.example.com.'
									}
								})
							)
						}
					}
				)
			},
			'/domains/{id}': {
				get: operation(
					'Read a domain',
					'domains:read',
					{ '200': domainResponse('The domain.') },
					{ parameters: [domainId] }
				),
				delete: operation(
					'Remove a custom domain',
					'domains:write',
					{ '204': { description: 'Removed. Its links stop within a minute.' } },
					{ parameters: [domainId] }
				)
			},
			'/domains/{id}/check': {
				post: operation(
					'Check a custom domain now',
					'domains:write',
					{ '200': domainResponse('The domain after the check.') },
					{ parameters: [domainId] }
				)
			},
			'/usage': {
				get: operation('Read usage against the workspace limits', 'usage:read', {
					'200': {
						description: 'Clicks in the current UTC month, links, domains, and limit warnings.',
						content: json(object({ usage: ref('Usage') }))
					}
				})
			},
			'/export/links': {
				get: operation(
					'Export every link',
					'links:read',
					{
						'200': {
							description: `Up to ${exportLinkPageSize} links, active and disabled, newest first. Follow nextCursor until it is null.`,
							content: json(ref('ExportLinkPage'))
						}
					},
					{ parameters: [cursor] }
				)
			},
			'/export/daily-totals': {
				get: operation(
					'Export retained daily click totals',
					'analytics:read',
					{
						'200': {
							description: `Up to ${exportAnalyticsPageSize} rows by link and UTC day, within the retention period.`,
							content: json(ref('ExportTotalsPage'))
						}
					},
					{ parameters: [cursor] }
				)
			},
			'/export/daily-dimensions': {
				get: operation(
					'Export retained daily breakdowns',
					'analytics:read',
					{
						'200': {
							description: `Up to ${exportAnalyticsPageSize} rows of clicks by link, UTC day, and country, device, referrer, browser, or OS, within the retention period.`,
							content: json(ref('ExportDimensionsPage'))
						}
					},
					{ parameters: [cursor] }
				)
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
