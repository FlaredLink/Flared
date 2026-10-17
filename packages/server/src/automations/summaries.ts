// SPDX-License-Identifier: AGPL-3.0-only
// Stored automation records as the API returns them, with times in ISO 8601.
import {
	automationActionTypes,
	automationTriggerTypes,
	automationsPerLink,
	type Automation,
	type AutomationFeatures,
	type AutomationPage,
	type AutomationRun,
	type LinkAutomation
} from '@flared/contracts/automations';
import type { AutomationRow, AutomationRunRow, LinkAutomationRow } from '@flared/data/automations';

const iso = (time: number) => new Date(time).toISOString();
const isoOrNull = (time: number | null) => (time === null ? null : iso(time));

export function automationSummary(row: AutomationRow): Automation {
	return {
		id: row.id,
		name: row.name,
		enabled: row.enabled,
		trigger: row.trigger,
		actions: row.actions,
		links: row.links,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt)
	};
}

// What this installation offers: email_owner needs email, post_message needs messages,
// destination_down needs checks.
export function automationPage(
	listed: { automations: AutomationRow[]; used: number; limit: number },
	features: AutomationFeatures
): AutomationPage {
	return {
		automations: listed.automations.map(automationSummary),
		used: listed.used,
		limit: listed.limit,
		actionTypes: automationActionTypes.filter(
			(type) =>
				(type !== 'email_owner' || features.email) &&
				(type !== 'post_message' || features.messages === true)
		),
		triggerTypes: automationTriggerTypes.filter(
			(type) => type !== 'destination_down' || features.destinationChecks
		),
		perLinkLimit: automationsPerLink
	};
}

export function linkAutomationSummary(row: LinkAutomationRow): LinkAutomation {
	return {
		automationId: row.automationId,
		name: row.name,
		enabled: row.enabled,
		trigger: row.trigger,
		state: row.state,
		endsAt: isoOrNull(row.endsAt),
		dueAt: isoOrNull(row.dueAt),
		firedAt: isoOrNull(row.firedAt),
		result: row.result,
		appliedAt: iso(row.armedAt),
		check: row.check && {
			lastCheckedAt: isoOrNull(row.check.lastCheckedAt),
			lastResult: row.check.lastResult,
			failures: row.check.failures
		}
	};
}

export function runSummary(row: AutomationRunRow): AutomationRun {
	return {
		id: row.id,
		linkId: row.linkId,
		shortUrl: row.shortUrl,
		state: row.state,
		result: row.result,
		actions: row.actions,
		createdAt: iso(row.createdAt)
	};
}
