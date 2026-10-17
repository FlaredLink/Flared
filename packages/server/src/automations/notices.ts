// SPDX-License-Identifier: AGPL-3.0-only
// The email to the workspace owner after a template with the email action ran: one per template
// and run, with the template's name, how many links it ran on, and the short URL when it was one.
import type { ClaimedNotice } from '@flared/data/notices';
import type { EmailContent } from '../email/transport';
import { escape } from '../notices';

export const automationNoticeKind = 'automation_ran';

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// The email for an automation notice, or null for a notice of another kind or with bad params.
// appUrl is the app's address, such as https://example.com/app; the email links to its
// Automations page.
export function automationNoticeEmail(
	notice: ClaimedNotice,
	to: string,
	appUrl: string
): EmailContent | null {
	if (notice.kind !== automationNoticeKind) return null;
	const { automationName, links, failed, shortUrl } = notice.params;
	if (typeof automationName !== 'string' || !automationName) return null;
	if (!isCount(links) || links < 1 || !isCount(failed) || failed > links) return null;
	if (shortUrl !== undefined && typeof shortUrl !== 'string') return null;
	// An owner can have several workspaces, so each email names the one it is about.
	const workspace = notice.workspaceName ? `workspace "${notice.workspaceName}"` : 'workspace';
	const target = links === 1 ? '1 link' : `${links} links`;
	const subject = `Automation "${automationName}" ran on ${target} in ${notice.workspaceName ? workspace : 'your workspace'}`;
	const lines = [
		shortUrl !== undefined && links === 1
			? `The automation "${automationName}" ran on ${shortUrl} in your ${workspace}.`
			: `The automation "${automationName}" ran on ${target} in your ${workspace}.`,
		failed === 0
			? 'It finished on every link.'
			: `It did not finish on ${failed === 1 ? '1 link' : `${failed} links`}. The Automations page shows why.`
	];
	const url = `${appUrl.replace(/\/+$/, '')}/automations`;
	return {
		to,
		subject,
		text: `${lines.join('\n\n')}\n\nSee its runs: ${url}`,
		html: `${lines.map((line) => `<p>${escape(line)}</p>`).join('')}<p><a href="${escape(url)}">See its runs</a></p>`
	};
}
