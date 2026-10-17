// SPDX-License-Identifier: AGPL-3.0-only
// The words for triggers, actions, states, and results, shared by the Automations page, the run
// history, and the link details.
import type {
	AutomationAction,
	AutomationActionType,
	AutomationResult,
	AutomationTrigger,
	AutomationTriggerType
} from '@flared/contracts/automations';
import { endpointLabel } from '../webhooks/client';

// A webhook endpoint the send-webhook action can name.
export interface AutomationEndpoint {
	id: string;
	url: string;
}

const numbers = new Intl.NumberFormat();

export const triggerLabels: Record<AutomationTriggerType, { label: string; description: string }> =
	{
		end_date: {
			label: 'End date',
			description: 'You set the date and time on each link when you apply the automation.'
		},
		link_age: {
			label: 'Days after creation',
			description: 'Counted from the time the link was created.'
		},
		clicks: {
			label: 'Clicks',
			description: 'Counted in steps of 100 from all the clicks Flared holds for the link.'
		},
		destination_down: {
			label: 'Destination stops loading',
			description: 'Flared checks the page about every six hours. Two failed checks in a row count.'
		}
	};

export const actionLabels: Record<AutomationActionType, string> = {
	change_destination: 'Change the destination',
	disable_link: 'Turn off the link',
	send_webhook: 'Send a webhook',
	email_owner: 'Email the workspace owner'
};

// The actions of a finished run, in the past tense.
export const ranLabels: Record<AutomationActionType, string> = {
	change_destination: 'Changed the destination',
	disable_link: 'Turned off the link',
	send_webhook: 'Sent a webhook',
	email_owner: 'Emailed the owner'
};

const days = (count: number) => `${numbers.format(count)} ${count === 1 ? 'day' : 'days'}`;

// The "When" step of a template.
export function triggerText(trigger: AutomationTrigger): string {
	switch (trigger.type) {
		case 'end_date':
			return 'The end date set on the link';
		case 'link_age':
			return `${days(trigger.days)} after the link is created`;
		case 'clicks':
			return `A link passes ${numbers.format(trigger.clicks)} clicks`;
		case 'destination_down':
			return 'The destination stops loading';
	}
}

// A URL without its scheme, and without the slash of an empty path.
export function shortUrlText(url: string): string {
	return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// A "Then" step of a template. endpoints is null when the viewer cannot see the endpoints.
export function actionText(
	action: AutomationAction,
	endpoints: readonly AutomationEndpoint[] | null
): string {
	switch (action.type) {
		case 'change_destination':
			return `Send visitors to ${shortUrlText(action.destination)}`;
		case 'disable_link':
			return 'Turn off the link';
		case 'send_webhook': {
			if (endpoints === null) return 'Send a webhook';
			const endpoint = endpoints.find((item) => item.id === action.endpointId);
			return endpoint
				? `Send a webhook to ${endpointLabel(endpoint.url)}`
				: 'Send a webhook to a deleted endpoint';
		}
		case 'email_owner':
			return 'Email the workspace owner';
	}
}

// Why a run or an application failed or was skipped.
export function resultText(result: AutomationResult): string {
	switch (result) {
		case 'link_blocked':
			return 'Flared blocked this link for abuse, so the destination did not change.';
		case 'endpoint_missing':
			return 'The webhook endpoint was deleted.';
		case 'webhooks_off':
			return 'Webhooks are off for this workspace.';
		case 'plan':
			return 'Automations are off for this workspace.';
		case 'off':
			return 'The automation was off when its trigger was met.';
		case 'attempts':
			return 'Flared could not finish the run after 5 tries.';
		case 'not_checkable':
			return 'Flared cannot check this destination.';
	}
}
