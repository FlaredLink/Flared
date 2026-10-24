// SPDX-License-Identifier: AGPL-3.0-only
// The OpenAPI 3.1 description of the public /v1 API. It is written by hand from the contracts
// in this package; tests check it against the API's routes and real responses. The session-only
// token management routes for the dashboard are not part of the public API.
import { browserFamilies, deviceCategories, osFamilies } from './analytics';
import {
	automationActionTypes,
	automationNameMaxLength,
	automationResults,
	automationTriggerTypes,
	automationsPerLink,
	maxApplyLinks,
	maxTriggerClicks,
	maxTriggerDays,
	minTriggerClicks,
	minTriggerDays,
	triggerClickStep
} from './automations';
import { domainFailures, domainSetups, domainStates } from './domains';
import { exportAnalyticsPageSize, exportDimensions, exportLinkPageSize } from './export';
import { errorStatus } from './errors';
import {
	blockReasons,
	maxDestinationLength,
	maxIdempotencyKeyLength,
	maxLinkPasswordLength,
	maxPreviewDescriptionLength,
	maxPreviewImageBytes,
	maxPreviewTitleLength,
	maxTitleLength,
	minLinkPasswordLength,
	recentClickDays
} from './links';
import {
	buttonShapes,
	buttonStyles,
	embedProviders,
	handlePattern,
	maxBlockLabelLength,
	maxPageBioLength,
	maxPageBlocks,
	maxPageTitleLength,
	maxPaymentDescriptionLength,
	maxPriceLength,
	maxSocialLinks,
	pageFonts,
	paymentProviders,
	socialNetworks,
	themePresets
} from './pages';
import { tokenScopes, type TokenScope } from './tokens';
import {
	defaultMilestoneInterval,
	maxMilestoneInterval,
	maxWebhookUrlLength,
	milestoneStep,
	minMilestoneInterval,
	subscribableWebhookEvents
} from './webhooks';

// Duplicated from the client's QR module, which this package cannot import.
const qrSizes = { minimum: 128, maximum: 2048, default: 512 };

export const openApiVersion = '1.12.0';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dateTime = { type: 'string', format: 'date-time' };
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const count = { type: 'integer', minimum: 0 };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const device = (os: string) => ({
	type: 'string',
	maxLength: maxDestinationLength,
	description: `Where ${os} visitors go instead of destination: an http(s) URL or an app link in the scheme://… form${os === 'Android' ? ', including intent://' : ''}. Link previews and other visitors get destination.`
});
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
	type: 'object',
	properties,
	required
});

const accessNote =
	' Setting it needs link access on the plan (LINK_ACCESS_REQUIRES_PLAN otherwise); clearing it does not.';
const linkStart = {
	...dateTime,
	description: `The link opens at this time: ISO 8601 with Z or an offset.${accessNote}`
};
const linkEnd = {
	...dateTime,
	description: `The link stops at this time, after startsAt: ISO 8601 with Z or an offset.${accessNote}`
};
const endedDestination = {
	type: 'string',
	format: 'uri',
	maxLength: maxDestinationLength,
	description: `Where visitors go after endsAt; needs endsAt. Without it, visitors see that the link has ended.${accessNote}`
};
const linkPassword = {
	type: 'string',
	minLength: minLinkPasswordLength,
	maxLength: maxLinkPasswordLength,
	description: `Visitors enter it before the redirect. It is stored as a hash and never returned; reads show hasPassword.${accessNote}`
};

const previewNote =
	' Setting it needs social previews on the plan (LINK_PREVIEW_REQUIRES_PLAN otherwise); clearing it does not.';
const previewTitle = {
	type: 'string',
	maxLength: maxPreviewTitleLength,
	description: `The title that link cards in chat apps and social networks show, instead of the destination page title.${previewNote}`
};
const previewDescription = {
	type: 'string',
	maxLength: maxPreviewDescriptionLength,
	description: `The description that link cards show, instead of the destination page description.${previewNote}`
};

const extrasNote =
	' Needs page extras on the plan (PAGE_EXTRAS_REQUIRES_PLAN otherwise); a block the page already has stays allowed.';
const blockSchedule = {
	startsAt: { ...nullable(dateTime), description: 'The block shows from this time; null is now.' },
	endsAt: { ...nullable(dateTime), description: 'The block hides after this time; null is never.' }
};
const blockLabel = { type: 'string', minLength: 1, maxLength: maxBlockLabelLength };
const destinationNote =
	' An installation can check the destinations of a link that the change adds (PAGE_DESTINATION_UNSAFE when one is listed as harmful).';
const colour = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const socialLink = object({
	network: { type: 'string', enum: Object.keys(socialNetworks) },
	address: {
		type: 'string',
		maxLength: 2048,
		description: 'An https profile address on the network, or an email address for email.'
	}
});
// The fields of each block kind as a request sends them; reads add shortUrl and visible.
const blockFields = {
	button: {
		linkId: { type: 'string', description: `A link of the workspace.${destinationNote}` },
		label: blockLabel
	},
	header: { label: blockLabel },
	social: {
		links: { type: 'array', minItems: 1, maxItems: maxSocialLinks, items: socialLink }
	},
	payment: {
		linkId: {
			type: 'string',
			description: `A link of the workspace that opens the provider's checkout page.${destinationNote}`
		},
		provider: { type: 'string', enum: Object.keys(paymentProviders) },
		label: blockLabel,
		price: {
			...nullable({ type: 'string', maxLength: maxPriceLength }),
			description: 'Shown as typed.'
		},
		description: nullable({ type: 'string', maxLength: maxPaymentDescriptionLength })
	},
	embed: {
		provider: { type: 'string', enum: Object.keys(embedProviders) },
		address: {
			type: 'string',
			format: 'uri',
			maxLength: 2048,
			description: "The address of the provider's page, such as a YouTube video."
		}
	},
	signup: { label: blockLabel, buttonLabel: { type: 'string', minLength: 1, maxLength: 40 } }
} as const;
const blockDescriptions: Record<keyof typeof blockFields, string> = {
	button: 'A button that opens a link of the workspace.',
	header: 'A section title.',
	social: 'A row of social icons.',
	payment: `A product card with a checkout button. Flared never takes or holds the payment.${extrasNote}`,
	embed: `A player or booking page from the provider.${extrasNote}`,
	signup: `An email sign-up form.${extrasNote}`
};
const blockSchema = (read: boolean) => ({
	oneOf: Object.entries(blockFields).map(([kind, fields]) => {
		const linked = kind === 'button' || kind === 'payment';
		const properties = {
			kind: { const: kind },
			...fields,
			...(read && linked ? { shortUrl: { type: 'string', format: 'uri' } } : {}),
			...blockSchedule,
			...(read
				? {
						visible: {
							type: 'boolean',
							description:
								"false while the block's link is off or blocked, or a card's link no longer opens the provider's checkout; the page then leaves the block out."
						}
					}
				: {})
		};
		const required = Object.keys(properties).filter(
			(key) => read || !['startsAt', 'endsAt', 'price', 'description'].includes(key)
		);
		return {
			...object(properties, required),
			description: blockDescriptions[kind as keyof typeof blockFields]
		};
	})
});
const pageSummaryFields = {
	id: { type: 'string' },
	handle: { type: 'string' },
	url: {
		...nullable({ type: 'string', format: 'uri' }),
		description: 'Where the page shows; null when this installation has no page host.'
	},
	domainUrl: {
		...nullable({ type: 'string', format: 'uri' }),
		description: 'The workspace domain whose root shows the page.'
	},
	title: { type: 'string' },
	enabled: { type: 'boolean' },
	blocked: {
		...nullable(object({ reason: { type: 'string', enum: [...blockReasons] } })),
		description: 'Set while Flared blocks the page for abuse.'
	},
	createdAt: dateTime,
	updatedAt: dateTime
};
const pageInputFields = {
	handle: {
		type: 'string',
		pattern: handlePattern.source,
		description:
			'The page address: 3 to 30 lowercase letters, digits, and single hyphens. A used address stays with its workspace for good.'
	},
	title: { type: 'string', minLength: 1, maxLength: maxPageTitleLength },
	bio: nullable({ type: 'string', maxLength: maxPageBioLength }),
	theme: ref('PageTheme'),
	blocks: { type: 'array', maxItems: maxPageBlocks, items: blockSchema(false) },
	domainId: {
		...nullable({ type: 'string' }),
		description: `A domain of the workspace whose root shows the page; one page per domain.${extrasNote}`
	}
};

const endsAt = {
	...dateTime,
	description:
		'Required by an end_date template and refused by the others: an ISO 8601 time with an offset, within 10 years. A past time runs at the next scheduled run.'
};

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
		iosDestination: nullable(device('iPhone')),
		androidDestination: nullable(device('Android')),
		startsAt: { ...nullable(dateTime), description: 'The link opens at this time; null is now.' },
		endsAt: { ...nullable(dateTime), description: 'The link stops at this time; null is never.' },
		endedDestination: {
			...nullable({ type: 'string', format: 'uri' }),
			description: 'Where visitors go after endsAt.'
		},
		hasPassword: {
			type: 'boolean',
			description: 'Visitors enter a password before the redirect.'
		},
		previewTitle: {
			...nullable({ type: 'string' }),
			description: 'The title that link cards show; null uses the destination page title.'
		},
		previewDescription: {
			...nullable({ type: 'string' }),
			description: 'The description that link cards show; null uses the destination page.'
		},
		previewImage: {
			...nullable({ type: 'string', format: 'uri' }),
			description:
				'The image that link cards show, on the short-link host. Set it with PUT /links/{id}/preview-image.'
		},
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
			domainId: { type: 'string', description: 'Omit for the default short-link domain.' },
			iosDestination: nullable(device('iPhone')),
			androidDestination: nullable(device('Android')),
			startsAt: nullable(linkStart),
			endsAt: nullable(linkEnd),
			endedDestination: nullable(endedDestination),
			password: nullable(linkPassword),
			previewTitle: nullable(previewTitle),
			previewDescription: nullable(previewDescription)
		},
		['destination']
	),
	UpdateLinkInput: {
		...object(
			{
				destination: { type: 'string', format: 'uri', maxLength: maxDestinationLength },
				title: nullable({ type: 'string', maxLength: maxTitleLength }),
				iosDestination: { ...nullable(device('iPhone')), description: 'null clears it.' },
				androidDestination: { ...nullable(device('Android')), description: 'null clears it.' },
				startsAt: {
					...nullable(linkStart),
					description: `null clears it. ${linkStart.description}`
				},
				endsAt: {
					...nullable(linkEnd),
					description: `null clears it and endedDestination. ${linkEnd.description}`
				},
				endedDestination: {
					...nullable(endedDestination),
					description: `null clears it. ${endedDestination.description}`
				},
				password: {
					...nullable(linkPassword),
					description: `null clears it. ${linkPassword.description}`
				},
				previewTitle: {
					...nullable(previewTitle),
					description: `null clears it. ${previewTitle.description}`
				},
				previewDescription: {
					...nullable(previewDescription),
					description: `null clears it. ${previewDescription.description}`
				},
				enabled: { type: 'boolean' }
			},
			[]
		),
		minProperties: 1
	},
	ImportLinksInput: object({
		dryRun: {
			type: 'boolean',
			description: 'true checks each item and writes nothing; false creates the links.'
		},
		items: {
			type: 'array',
			items: ref('CreateLinkInput'),
			minItems: 1,
			description:
				'Links to create, in order. Each installation sets the most items in one request (3 by default); more fail with TOO_MANY_ITEMS. An invalid item fails alone.'
		}
	}),
	ImportItemResult: object(
		{
			index: { ...count, description: 'The item’s position in items.' },
			status: {
				type: 'string',
				enum: ['ready', 'created', 'failed'],
				description:
					'ready: a dry run found nothing that stops the item. created: the link exists. failed: see error; nothing was created.'
			},
			link: ref('Link'),
			error: object(
				{
					code: { type: 'string', enum: Object.keys(errorStatus) },
					message: { type: 'string' },
					field: { type: 'string', description: 'The input that failed validation.' }
				},
				['code', 'message']
			)
		},
		['index', 'status']
	),
	ImportLinksResult: object({
		dryRun: { type: 'boolean' },
		results: { type: 'array', items: ref('ImportItemResult') },
		summary: {
			oneOf: [object({ ready: count, failed: count }), object({ created: count, failed: count })],
			description: 'ready and failed for a dry run; created and failed otherwise.'
		}
	}),
	DailyClicks: object({ day, clicks: count }),
	DimensionClicks: object({ value: { type: 'string' }, clicks: count }),
	DailyViews: object({ day, views: count }),
	DimensionViews: object({ value: { type: 'string' }, views: count }),
	PageAnalytics: object({
		pageId: { type: 'string' },
		from: day,
		to: day,
		views: { ...count, description: 'Page views by people; bots and prefetches do not count.' },
		days: { type: 'array', items: ref('DailyViews') },
		countries: {
			type: 'array',
			items: ref('DimensionViews'),
			description: 'Two-letter country codes, or "unknown".'
		},
		devices: {
			type: 'array',
			items: ref('DimensionViews'),
			description: `One of ${deviceCategories.join(', ')}.`
		},
		referrers: {
			type: 'array',
			items: ref('DimensionViews'),
			description: 'Referrer host names; at most 50 per page and day, the rest under "other".'
		},
		browsers: {
			type: 'array',
			items: ref('DimensionViews'),
			description: `One of ${browserFamilies.join(', ')}.`
		},
		operatingSystems: {
			type: 'array',
			items: ref('DimensionViews'),
			description: `One of ${osFamilies.join(', ')}.`
		},
		buttons: {
			type: 'array',
			items: object({ linkId: { type: 'string' }, label: { type: 'string' }, clicks: count }),
			description:
				"The links of the page's buttons and payment cards, most clicks first: one entry per link, with the label of the first block that opens it. clicks counts the clicks of the link that came from one of the page's addresses."
		},
		asOf: dateTime
	}),
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
		workspace: {
			...object({ id: { type: 'string' }, name: { type: 'string' } }),
			description: 'The workspace the usage belongs to.'
		},
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
		setup: {
			...nullable({ type: 'string', enum: [...domainSetups] }),
			description:
				'How to connect the hostname. dns: create the records below. worker_custom_domain: add the hostname as a Custom Domain of this installation’s Worker in the Cloudflare dashboard. Null for platform domains.'
		},
		records: {
			type: 'array',
			items: object({
				type: { const: 'CNAME' },
				name: { type: 'string' },
				value: { type: 'string' }
			}),
			description: 'The DNS records to create when setup is dns. Otherwise empty.'
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
	AutomationTrigger: {
		oneOf: [
			object({ type: { const: 'end_date' } }),
			object({
				type: { const: 'link_age' },
				days: { type: 'integer', minimum: minTriggerDays, maximum: maxTriggerDays }
			}),
			object({
				type: { const: 'clicks' },
				clicks: {
					type: 'integer',
					minimum: minTriggerClicks,
					maximum: maxTriggerClicks,
					multipleOf: triggerClickStep
				}
			}),
			object({ type: { const: 'destination_down' } })
		],
		description:
			'end_date: at the end date given when the template is applied to a link. link_age: this many days after the link was created. clicks: when the link reaches this many counted clicks. destination_down: when the destination fails two checks in a row, where the installation checks destinations.'
	},
	AutomationAction: {
		oneOf: [
			object({
				type: { const: 'change_destination' },
				destination: { type: 'string', format: 'uri', maxLength: maxDestinationLength }
			}),
			object({ type: { const: 'disable_link' } }),
			object({
				type: { const: 'send_webhook' },
				endpointId: { type: 'string', description: 'A webhook endpoint of the workspace.' }
			}),
			object({
				type: { const: 'post_message' },
				endpointId: {
					type: 'string',
					description: 'A message target of the workspace, where the installation posts messages.'
				}
			}),
			object({ type: { const: 'email_owner' } })
		],
		description:
			'Actions run in this order: change the destination, turn the link off, send an automation.triggered event to the webhook endpoint, post a message to the message target, email the workspace owner.'
	},
	Automation: object({
		id: { type: 'string' },
		name: { type: 'string', minLength: 1, maxLength: automationNameMaxLength },
		enabled: {
			type: 'boolean',
			description: 'A template that is off does not run; its due applications are skipped.'
		},
		trigger: ref('AutomationTrigger'),
		actions: {
			type: 'array',
			items: ref('AutomationAction'),
			minItems: 1,
			maxItems: automationActionTypes.length
		},
		links: { ...count, description: 'Links the template is applied to, whether it ran or not.' },
		createdAt: dateTime,
		updatedAt: dateTime
	}),
	AutomationPage: object({
		automations: { type: 'array', items: ref('Automation') },
		used: count,
		limit: { ...count, description: 'Templates the workspace may keep; 0 turns automations off.' },
		actionTypes: {
			type: 'array',
			items: { type: 'string', enum: [...automationActionTypes] },
			description: 'The actions this installation offers.'
		},
		triggerTypes: {
			type: 'array',
			items: { type: 'string', enum: [...automationTriggerTypes] },
			description: 'The triggers this installation offers.'
		},
		perLinkLimit: { const: automationsPerLink, description: 'Templates one link takes at most.' }
	}),
	LinkAutomation: object({
		automationId: { type: 'string' },
		name: { type: 'string' },
		enabled: { type: 'boolean' },
		trigger: ref('AutomationTrigger'),
		state: {
			type: 'string',
			enum: ['waiting', 'done', 'failed', 'skipped'],
			description:
				'waiting: not run yet. done: it ran. failed and skipped: see result. Each application runs once; applying the template again re-arms it.'
		},
		endsAt: nullable(dateTime),
		dueAt: { ...nullable(dateTime), description: 'When the trigger is met, once that is known.' },
		firedAt: nullable(dateTime),
		result: nullable({ type: 'string', enum: [...automationResults] }),
		appliedAt: dateTime,
		check: {
			...nullable(
				object({
					lastCheckedAt: nullable(dateTime),
					lastResult: nullable({ type: 'string' }),
					failures: count
				})
			),
			description: 'The destination checks of a destination_down template; null for the others.'
		}
	}),
	LinkAutomationPage: object({
		linkId: { type: 'string' },
		automations: { type: 'array', items: ref('LinkAutomation'), maxItems: automationsPerLink }
	}),
	ApplyLinkAutomationResult: {
		allOf: [
			ref('LinkAutomationPage'),
			object({
				status: {
					type: 'string',
					enum: ['applied', 'unchanged'],
					description: 'unchanged: the template already waited on the link with the same end date.'
				}
			})
		]
	},
	ApplyAutomationInput: object(
		{
			endsAt
		},
		[]
	),
	ApplyAutomationLinksInput: object(
		{
			linkIds: {
				type: 'array',
				items: { type: 'string' },
				minItems: 1,
				maxItems: maxApplyLinks,
				description: `Up to ${maxApplyLinks} link IDs; more fail with TOO_MANY_ITEMS.`
			},
			endsAt
		},
		['linkIds']
	),
	ApplyAutomationLinkResult: object(
		{
			linkId: { type: 'string' },
			status: { type: 'string', enum: ['applied', 'unchanged', 'failed'] },
			error: object({
				code: { type: 'string', enum: Object.keys(errorStatus) },
				message: { type: 'string' }
			})
		},
		['linkId', 'status']
	),
	ApplyAutomationLinksResult: object({
		results: { type: 'array', items: ref('ApplyAutomationLinkResult') }
	}),
	HookEvent: {
		type: 'string',
		enum: [...subscribableWebhookEvents],
		description:
			'link.disabled and link.enabled are edits that turn the link off or on; link.updated is any other edit.'
	},
	CreateHookInput: object(
		{
			event: ref('HookEvent'),
			targetUrl: {
				type: 'string',
				format: 'uri',
				maxLength: maxWebhookUrlLength,
				description:
					'An https URL on a host that this installation sends hooks to. Flared POSTs each event to it as one JSON object: the link fields, then clicks (milestones) or previous (edits), then event, eventId, and occurredAt. Answer 410 to end the hook.'
			},
			milestoneInterval: {
				...nullable({
					type: 'integer',
					minimum: minMilestoneInterval,
					maximum: maxMilestoneInterval,
					multipleOf: milestoneStep
				}),
				description: `For link.click_milestone: the hook gets every milestone that this number divides. ${defaultMilestoneInterval} when left out.`
			}
		},
		['event', 'targetUrl']
	),
	Hook: object({
		id: { type: 'string' },
		event: ref('HookEvent'),
		milestoneInterval: nullable(count),
		createdAt: dateTime,
		renewAt: {
			...dateTime,
			description: 'Subscribe again after this time, then delete this hook.'
		},
		expiresAt: {
			...dateTime,
			description: 'The hook gets no event that happens at or after this time.'
		}
	}),
	Workspace: object({
		id: { type: 'string' },
		name: { type: 'string' },
		role: { type: 'string', enum: ['owner', 'member'] }
	}),
	Identity: {
		oneOf: [
			object({
				kind: { const: 'session' },
				scopes: { type: 'array', items: ref('Scope') },
				workspace: { ...ref('Workspace'), description: 'The workspace the session acts in.' }
			}),
			object({
				kind: { const: 'token' },
				scopes: { type: 'array', items: ref('Scope') },
				workspace: { ...ref('Workspace'), description: 'The workspace the token acts in.' },
				token: object({
					id: { type: 'string' },
					name: { type: 'string' },
					start: { type: 'string', description: 'The prefix and first characters.' },
					expiresAt: nullable(dateTime)
				})
			}),
			object({
				kind: { const: 'oauth' },
				scopes: { type: 'array', items: ref('Scope') },
				workspace: {
					...ref('Workspace'),
					description: 'The workspace the person chose when they connected the app.'
				}
			})
		]
	},
	PageTheme: object(
		{
			id: { type: 'string', enum: themePresets.map((preset) => preset.id) },
			background: colour,
			text: colour,
			buttonBackground: colour,
			buttonText: colour,
			font: { type: 'string', enum: [...pageFonts] },
			buttonShape: { type: 'string', enum: [...buttonShapes] },
			buttonStyle: { type: 'string', enum: [...buttonStyles] }
		},
		['id']
	),
	PageSummary: object(pageSummaryFields),
	Page: object({
		...pageSummaryFields,
		domainId: nullable({ type: 'string' }),
		bio: nullable({ type: 'string' }),
		avatarImage: {
			...nullable({ type: 'string', format: 'uri' }),
			description:
				'The avatar on the page host, or else on the workspace domain. Set it with PUT /pages/{id}/avatar-image.'
		},
		backgroundImage: {
			...nullable({ type: 'string', format: 'uri' }),
			description: 'The background image. Set it with PUT /pages/{id}/background-image.'
		},
		theme: ref('PageTheme'),
		blocks: { type: 'array', items: blockSchema(true) }
	}),
	PageList: object({
		pages: { type: 'array', items: ref('PageSummary') },
		nextCursor: nullable({ type: 'string' })
	}),
	CreatePageInput: object(pageInputFields, ['handle', 'title']),
	UpdatePageInput: {
		...object(
			{
				...pageInputFields,
				enabled: { type: 'boolean' }
			},
			[]
		),
		minProperties: 1,
		description: 'Send the fields to change; blocks replaces the whole list.'
	}
};

const json = (schema: unknown) => ({ 'application/json': { schema } });
const errorResponse = { description: 'An error. See the code.', content: json(ref('Error')) };
const linkId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const domainId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const pageId = {
	name: 'id',
	in: 'path',
	required: true,
	schema: { type: 'string' },
	description: 'A page ID from GET /v1/pages.'
};
const automationId = (name: string) => ({
	name,
	in: 'path',
	required: true,
	schema: { type: 'string' },
	description: 'An automation ID from GET /v1/automations.'
});
const cursor = {
	name: 'cursor',
	in: 'query',
	description: 'The nextCursor of the previous page.',
	schema: { type: 'string' }
};
const hookId = {
	name: 'id',
	in: 'path',
	required: true,
	schema: { type: 'string' },
	description: 'A hook ID from POST /v1/hooks.'
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
		description: !scope
			? 'Needs no scope.'
			: scope === 'domains:write'
				? `Needs the \`${scope}\` scope and the workspace owner role.`
				: `Needs the \`${scope}\` scope.`,
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
				'Create and edit short links and read their click analytics. Authenticate with an API token from Settings in the Flared app: `Authorization: Bearer flr_…`. Each token works in one workspace and only for its scopes. A token of a workspace member cannot use `domains:write`.',
			license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' }
		},
		servers: [{ url: serverUrl }],
		security: [{ bearerAuth: [] }],
		paths: {
			'/me': {
				get: operation('Describe the calling token and its workspace', null, {
					'200': {
						description: 'The credential and the workspace it acts in.',
						content: json(ref('Identity'))
					}
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
							},
							{
								name: 'domain',
								in: 'query',
								description: 'Only links on this domain, by its ID from GET /v1/domains.',
								schema: { type: 'string', maxLength: 64 }
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
			'/links/import': {
				post: operation(
					'Import links in bulk',
					'links:write',
					{
						'200': {
							description:
								'One result for each item, in order. A repeated request with the same key and items returns the same results and creates nothing twice. A real run must fit the workspace’s hourly import allowance as a whole, or it answers 429 with Retry-After and creates nothing; a dry run uses none of it.',
							content: json(ref('ImportLinksResult'))
						}
					},
					{
						parameters: [
							{
								name: 'Idempotency-Key',
								in: 'header',
								required: true,
								description:
									'Kept for 24 hours. Reuse it with the same items to retry safely; each item is stored as `<key>:<index>`.',
								schema: { type: 'string', minLength: 1, maxLength: maxIdempotencyKeyLength }
							}
						],
						requestBody: { required: true, content: json(ref('ImportLinksInput')) }
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
			'/links/{id}/preview-image': {
				put: operation(
					'Set the image of a link card',
					'links:write',
					{
						'200': {
							description: 'The link with its new previewImage.',
							content: json(object({ link: ref('Link') }))
						}
					},
					{
						parameters: [linkId],
						description: `Needs the \`links:write\` scope and social previews on the plan (LINK_PREVIEW_REQUIRES_PLAN otherwise). Send the image itself as the body: PNG, JPEG, or WebP, at most ${maxPreviewImageBytes / 1024 / 1024} MB; 1200 x 630 pixels shows best. A new image replaces the old one.`,
						requestBody: {
							required: true,
							content: Object.fromEntries(
								['image/png', 'image/jpeg', 'image/webp'].map((type) => [
									type,
									{ schema: { type: 'string', format: 'binary' } }
								])
							)
						}
					}
				),
				delete: operation(
					'Remove the image of a link card',
					'links:write',
					{
						'200': {
							description: 'The link without previewImage.',
							content: json(object({ link: ref('Link') }))
						}
					},
					{ parameters: [linkId] }
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
			'/links/{id}/automations': {
				get: operation(
					'List the automations applied to a link',
					'links:read',
					{
						'200': {
							description: 'The templates on the link, oldest application first.',
							content: json(ref('LinkAutomationPage'))
						}
					},
					{ parameters: [linkId] }
				)
			},
			'/links/{id}/automations/{automationId}': {
				put: operation(
					'Apply an automation to a link',
					'links:write',
					{
						'200': {
							description:
								'The templates on the link after the apply. A link takes at most 5 templates.',
							content: json(ref('ApplyLinkAutomationResult'))
						}
					},
					{
						parameters: [linkId, automationId('automationId')],
						requestBody: { required: false, content: json(ref('ApplyAutomationInput')) }
					}
				),
				delete: operation(
					'Remove an automation from a link',
					'links:write',
					{ '204': { description: 'Removed. The template stays in the workspace.' } },
					{ parameters: [linkId, automationId('automationId')] }
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
						'201': domainResponse('The domain. Follow its setup next.'),
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
			'/hooks': {
				post: operation(
					'Subscribe a hook to a link event',
					'links:read',
					{
						'201': {
							description:
								'The hook. A subscribe by the same person with the same event and target URL replaces their earlier hook. Workspaces without webhooks on their plan get WEBHOOK_LIMIT_REACHED, and so does the 51st live hook.',
							content: json(object({ hook: ref('Hook') }))
						}
					},
					{ requestBody: { required: true, content: json(ref('CreateHookInput')) } }
				)
			},
			'/hooks/{id}': {
				delete: operation(
					'Delete a hook',
					'links:read',
					{
						'204': {
							description:
								'Deleted. A member deletes their own hooks; the workspace owner deletes any.'
						}
					},
					{ parameters: [hookId] }
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
							description:
								'Up to limit links, active and disabled, newest first. Follow nextCursor until it is null.',
							content: json(ref('ExportLinkPage'))
						}
					},
					{
						parameters: [
							cursor,
							{
								name: 'limit',
								in: 'query',
								schema: {
									type: 'integer',
									minimum: 1,
									maximum: exportLinkPageSize,
									default: exportLinkPageSize
								}
							}
						]
					}
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
			'/automations': {
				get: operation('List the workspace’s automation templates', 'links:read', {
					'200': {
						description:
							'Templates, oldest first. Each is a trigger, then its actions. The workspace owner creates them in the Flared app.',
						content: json(ref('AutomationPage'))
					}
				})
			},
			'/automations/{id}/links': {
				post: operation(
					'Apply an automation to links',
					'links:write',
					{
						'200': {
							description:
								'One result for each link, in order; each link is applied or fails on its own. Applying again re-arms a template that already ran on a link.',
							content: json(ref('ApplyAutomationLinksResult'))
						}
					},
					{
						parameters: [automationId('id')],
						requestBody: { required: true, content: json(ref('ApplyAutomationLinksInput')) }
					}
				)
			},
			'/pages': {
				get: operation(
					'List pages, newest first',
					'links:read',
					{ '200': { description: 'A page of pages.', content: json(ref('PageList')) } },
					{ parameters: [cursor] }
				),
				post: operation(
					'Create a page',
					'links:write',
					{
						'201': {
							description:
								'The page. The workspace keeps as many pages as its plan allows (PAGE_LIMIT_REACHED otherwise).',
							content: json(object({ page: ref('Page') }))
						}
					},
					{ requestBody: { required: true, content: json(ref('CreatePageInput')) } }
				)
			},
			'/pages/{id}': {
				get: operation(
					'Read a page',
					'links:read',
					{ '200': { description: 'The page.', content: json(object({ page: ref('Page') })) } },
					{ parameters: [pageId] }
				),
				patch: operation(
					'Edit a page',
					'links:write',
					{
						'200': {
							description: 'The changed page.',
							content: json(object({ page: ref('Page') }))
						}
					},
					{
						parameters: [pageId],
						requestBody: { required: true, content: json(ref('UpdatePageInput')) }
					}
				),
				delete: operation(
					'Delete a page',
					'links:write',
					{
						'204': {
							description:
								'Deleted. Its address stays with the workspace, and no other workspace can take it.'
						}
					},
					{ parameters: [pageId] }
				)
			},
			'/pages/{id}/avatar-image': {
				put: operation(
					'Set the avatar image of a page',
					'links:write',
					{
						'200': {
							description: 'The page with its new avatarImage.',
							content: json(object({ page: ref('Page') }))
						}
					},
					{
						parameters: [pageId],
						description: `Send the image itself as the body: PNG, JPEG, or WebP, at most ${maxPreviewImageBytes / 1024 / 1024} MB. A new image replaces the old one.`,
						requestBody: {
							required: true,
							content: Object.fromEntries(
								['image/png', 'image/jpeg', 'image/webp'].map((type) => [
									type,
									{ schema: { type: 'string', format: 'binary' } }
								])
							)
						}
					}
				),
				delete: operation(
					'Remove the avatar image of a page',
					'links:write',
					{
						'200': {
							description: 'The page without avatarImage.',
							content: json(object({ page: ref('Page') }))
						}
					},
					{ parameters: [pageId] }
				)
			},
			'/pages/{id}/background-image': {
				put: operation(
					'Set the background image of a page',
					'links:write',
					{
						'200': {
							description: 'The page with its new backgroundImage.',
							content: json(object({ page: ref('Page') }))
						}
					},
					{
						parameters: [pageId],
						description: `Send the image itself as the body: PNG, JPEG, or WebP, at most ${maxPreviewImageBytes / 1024 / 1024} MB. A new image replaces the old one.`,
						requestBody: {
							required: true,
							content: Object.fromEntries(
								['image/png', 'image/jpeg', 'image/webp'].map((type) => [
									type,
									{ schema: { type: 'string', format: 'binary' } }
								])
							)
						}
					}
				),
				delete: operation(
					'Remove the background image of a page',
					'links:write',
					{
						'200': {
							description: 'The page without backgroundImage.',
							content: json(object({ page: ref('Page') }))
						}
					},
					{ parameters: [pageId] }
				)
			},
			'/pages/{id}/analytics': {
				get: operation(
					'Read view analytics for a page',
					'analytics:read',
					{
						'200': {
							description:
								'UTC daily views, breakdowns, and button clicks, clamped to the retention period. Page views do not count against the monthly click allowance.',
							content: json(object({ analytics: ref('PageAnalytics') }))
						}
					},
					{
						parameters: [
							pageId,
							{ name: 'from', in: 'query', schema: day },
							{ name: 'to', in: 'query', schema: day }
						]
					}
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
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					description: 'An API token (flr_…), or an OAuth access token issued for this API.'
				}
			},
			schemas
		}
	};
}
