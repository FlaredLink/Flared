// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store records for automations: templates, their applications to links, and the record
// of each run. A run changes the link and stages its webhook events in one batch, as updateLink
// does, with the fragments from webhooks.ts.
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/index.ts';
import {
	automationActionTypes,
	automationsPerLink,
	isAutomationActionType,
	isAutomationResult,
	type AutomationAction,
	type AutomationActionType,
	type AutomationResult,
	type AutomationRunState,
	type AutomationTrigger,
	type LinkAutomationState
} from '@flared/contracts/automations';
import { isoTime, linkJson, webhooksOn, type ClickMilestone } from './webhooks';

// A claim is an attempt. After this many claims with no finished run, the application fails.
export const automationMaxAttempts = 5;
// A claimed application waits this long for its run before another run may claim it.
export const automationLeaseMs = 15 * 60000;
// Run records are kept this long.
export const automationRunLifetimeMs = 90 * 86400000;
export const recentRunCount = 100;
// A destination is checked again after this long at the earliest.
export const destinationRecheckMs = 6 * 3600000;
// Failed checks in a row, of the same destination, that make a destination_down template due.
export const destinationFailuresToTrigger = 2;

export interface AutomationRow {
	id: string;
	tenantId: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	actions: AutomationAction[];
	// Applications of the template, whether they ran or not.
	links: number;
	createdAt: number;
	updatedAt: number;
}

export interface NewAutomation {
	id: string;
	tenantId: string;
	name: string;
	trigger: AutomationTrigger;
	actions: AutomationAction[];
	now: number;
}

// limit: the workspace keeps as many templates as its limit allows (0: automations are off).
// endpoint_missing: the send_webhook action names no endpoint of the workspace.
export type CreateAutomationResult =
	| { status: 'created'; automation: AutomationRow }
	| { status: 'limit'; limit: number }
	| { status: 'endpoint_missing' }
	| { status: 'no_workspace' };

// undefined keeps a field. trigger must keep the stored type; actions replaces the whole list.
export interface AutomationChange {
	name?: string;
	enabled?: boolean;
	trigger?: AutomationTrigger;
	actions?: AutomationAction[];
	now: number;
}

export type UpdateAutomationResult =
	| { status: 'updated'; automation: AutomationRow }
	| { status: 'not_found' }
	| { status: 'trigger_type' }
	| { status: 'endpoint_missing' };

export interface LinkAutomationRow {
	automationId: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	state: LinkAutomationState;
	endsAt: number | null;
	dueAt: number | null;
	firedAt: number | null;
	result: AutomationResult | null;
	armedAt: number;
	// Set for a destination_down template.
	check: { lastCheckedAt: number | null; lastResult: string | null; failures: number } | null;
}

// endsAt: required for an end_date template and ignored by the others; the caller checks it
// against the template first (automationEndsAt in the contracts).
export interface ApplyRequest {
	tenantId: string;
	automationId: string;
	linkIds: string[];
	endsAt: number | null;
	now: number;
}

// unchanged: the template already waits on the link with the same end date. blocked: the
// operator blocked the link. link_limit: the link has automationsPerLink templates already.
export type ApplyLinkOutcome = 'applied' | 'unchanged' | 'not_found' | 'blocked' | 'link_limit';

// not_found: the workspace has no such template. off: its automation limit is 0. Nothing is
// applied in either case.
export type ApplyResult =
	| { status: 'not_found' }
	| { status: 'off' }
	| { status: 'done'; links: { linkId: string; outcome: ApplyLinkOutcome }[] };

export interface ClaimedApplication {
	tenantId: string;
	linkId: string;
	automationId: string;
}

// A due application that will not run: skipped for plan (limit 0) or off (template off), or
// failed for attempts.
export interface SkippedApplication extends ClaimedApplication {
	state: 'skipped' | 'failed';
	result: AutomationResult;
}

// One claimed application in a run, with the IDs the run may write: the link event (staged only
// while the workspace has webhooks on and the link changes), the automation.triggered event, and
// the run record.
export interface RunItem {
	linkId: string;
	automationId: string;
	linkEventId: string;
	triggerEventId: string;
	runId: string;
}

// One email notice per template per run. shortUrl is set when the template ran on one link.
export interface AutomationEmail {
	tenantId: string;
	automationId: string;
	automationName: string;
	links: number;
	failed: number;
	shortUrl: string | null;
}

export interface AutomationRunRow {
	id: string;
	linkId: string;
	shortUrl: string | null;
	state: AutomationRunState;
	result: AutomationResult | null;
	actions: AutomationActionType[];
	createdAt: number;
}

export interface DestinationCheck {
	tenantId: string;
	linkId: string;
	automationId: string;
	destination: string;
}

// key: identifies the destination checked, so an edited destination starts the count again.
// result: what the check saw, shown on the link, such as 404 or not_checkable.
export interface DestinationCheckResult {
	linkId: string;
	automationId: string;
	key: string;
	failed: boolean;
	result: string;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function count(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalCount(value: unknown, field: string): number | null {
	return value === null ? null : count(value, field);
}

function optionalText(value: unknown, field: string): string | null {
	return value === null ? null : text(value, field);
}

function batchSize(limit: number, max: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
		throw new Error('Invalid automation batch size');
	return limit;
}

function result(value: unknown): AutomationResult | null {
	if (value === null) return null;
	if (!isAutomationResult(value)) throw new Error('Invalid stored automation result');
	return value;
}

function applicationState(value: unknown): LinkAutomationState {
	if (value === 'waiting' || value === 'done' || value === 'failed' || value === 'skipped')
		return value;
	throw new Error('Invalid stored application state');
}

function runState(value: unknown): AutomationRunState {
	if (value === 'succeeded' || value === 'failed' || value === 'skipped') return value;
	throw new Error('Invalid stored run state');
}

function storedActionTypes(value: unknown): AutomationActionType[] {
	const actions: unknown = JSON.parse(text(value, 'run actions'));
	if (!Array.isArray(actions)) throw new Error('Invalid stored run actions');
	return actions.map((action) => {
		if (!isAutomationActionType(action)) throw new Error('Invalid stored run action');
		return action;
	});
}

function toTrigger(row: Record<string, unknown>): AutomationTrigger {
	switch (row.trigger_type) {
		case 'end_date':
			return { type: 'end_date' };
		case 'link_age':
			return { type: 'link_age', days: count(row.trigger_days, 'trigger days') };
		case 'clicks':
			return { type: 'clicks', clicks: count(row.trigger_clicks, 'trigger clicks') };
		case 'destination_down':
			return { type: 'destination_down' };
		default:
			throw new Error('Invalid stored trigger type');
	}
}

// In the order the actions run.
function toActions(row: Record<string, unknown>): AutomationAction[] {
	const actions: AutomationAction[] = [];
	if (row.set_destination !== null)
		actions.push({
			type: 'change_destination',
			destination: text(row.set_destination, 'destination')
		});
	if (row.disable_link === 1) actions.push({ type: 'disable_link' });
	if (row.webhook_endpoint_id !== null)
		actions.push({ type: 'send_webhook', endpointId: text(row.webhook_endpoint_id, 'endpoint') });
	if (row.email_owner === 1) actions.push({ type: 'email_owner' });
	return actions;
}

const automationColumns =
	'id, tenant_id, name, enabled, trigger_type, trigger_days, trigger_clicks, set_destination, disable_link, webhook_endpoint_id, email_owner, created_at, updated_at';

// SQL: the applications of the template row `a`.
const applicationCount = (a: string) =>
	`(SELECT COUNT(*) FROM link_automations x WHERE x.automation_id = ${a}.id)`;

function toAutomation(row: Record<string, unknown>): AutomationRow {
	return {
		id: text(row.id, 'automation'),
		tenantId: text(row.tenant_id, 'tenant'),
		name: text(row.name, 'automation name'),
		enabled: row.enabled === 1,
		trigger: toTrigger(row),
		actions: toActions(row),
		links: count(row.links, 'application count'),
		createdAt: count(row.created_at, 'creation time'),
		updatedAt: count(row.updated_at, 'update time')
	};
}

function triggerColumns(trigger: AutomationTrigger): [string, number | null, number | null] {
	return [
		trigger.type,
		trigger.type === 'link_age' ? trigger.days : null,
		trigger.type === 'clicks' ? trigger.clicks : null
	];
}

// set_destination, disable_link, webhook_endpoint_id, email_owner.
function actionColumns(
	actions: AutomationAction[]
): [string | null, number, string | null, number] {
	if (actions.length === 0 || actions.length > automationActionTypes.length)
		throw new Error('Invalid automation actions');
	let destination: string | null = null;
	let disable = 0;
	let endpoint: string | null = null;
	let email = 0;
	for (const action of actions)
		if (action.type === 'change_destination') destination = action.destination;
		else if (action.type === 'disable_link') disable = 1;
		else if (action.type === 'send_webhook') endpoint = action.endpointId;
		else email = 1;
	return [destination, disable, endpoint, email];
}

// One statement counts the templates, checks the webhook endpoint, and inserts, so two creates at
// once cannot both take the last place under the limit.
export async function createAutomation(
	db: D1Database,
	automation: NewAutomation
): Promise<CreateAutomationResult> {
	const actions = actionColumns(automation.actions);
	const row = await db
		.prepare(
			`INSERT INTO automations (id, tenant_id, name, trigger_type, trigger_days, trigger_clicks, set_destination, disable_link, webhook_endpoint_id, email_owner, created_at, updated_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11 FROM tenant_policy p WHERE p.tenant_id = ?2
			AND (SELECT COUNT(*) FROM automations WHERE tenant_id = ?2) < COALESCE(p.automation_limit, 0)
			AND (?9 IS NULL OR EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?9 AND tenant_id = ?2))
			RETURNING ${automationColumns}, 0 AS links`
		)
		.bind(
			automation.id,
			automation.tenantId,
			automation.name,
			...triggerColumns(automation.trigger),
			...actions,
			automation.now
		)
		.first<Record<string, unknown>>();
	if (row) return { status: 'created', automation: toAutomation(row) };
	// Nothing was written; say why. The insert above already kept the limit.
	const policy = await db
		.prepare(
			`SELECT COALESCE(automation_limit, 0) AS automation_limit,
				(SELECT COUNT(*) FROM automations WHERE tenant_id = ?1) AS used,
				(?2 IS NULL OR EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?2 AND tenant_id = ?1)) AS endpoint
			FROM tenant_policy WHERE tenant_id = ?1`
		)
		.bind(automation.tenantId, actions[2])
		.first<Record<string, unknown>>();
	if (!policy) return { status: 'no_workspace' };
	const limit = count(policy.automation_limit, 'automation limit');
	if (count(policy.used, 'automation count') < limit && policy.endpoint === 0)
		return { status: 'endpoint_missing' };
	return { status: 'limit', limit };
}

// The trigger type never changes: a trigger of another type changes nothing. A new number of
// days or clicks applies to the waiting applications in the same batch; finished ones keep
// their record.
export async function updateAutomation(
	db: D1Database,
	tenantId: string,
	automationId: string,
	change: AutomationChange
): Promise<UpdateAutomationResult> {
	const trigger = change.trigger ? triggerColumns(change.trigger) : [null, null, null];
	const actions = change.actions ? actionColumns(change.actions) : [null, 0, null, 0];
	const statements = [
		db
			.prepare(
				`UPDATE automations SET
					name = COALESCE(?3, name),
					enabled = COALESCE(?4, enabled),
					trigger_days = CASE WHEN ?5 IS NULL THEN trigger_days ELSE ?6 END,
					trigger_clicks = CASE WHEN ?5 IS NULL THEN trigger_clicks ELSE ?7 END,
					set_destination = CASE WHEN ?8 = 1 THEN ?9 ELSE set_destination END,
					disable_link = CASE WHEN ?8 = 1 THEN ?10 ELSE disable_link END,
					webhook_endpoint_id = CASE WHEN ?8 = 1 THEN ?11 ELSE webhook_endpoint_id END,
					email_owner = CASE WHEN ?8 = 1 THEN ?12 ELSE email_owner END,
					updated_at = ?13
				WHERE tenant_id = ?1 AND id = ?2 AND (?5 IS NULL OR trigger_type = ?5)
				AND (?8 = 0 OR ?11 IS NULL OR EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?11 AND tenant_id = ?1))
				RETURNING ${automationColumns}, ${applicationCount('automations')} AS links`
			)
			.bind(
				tenantId,
				automationId,
				change.name ?? null,
				change.enabled === undefined ? null : change.enabled ? 1 : 0,
				...trigger,
				change.actions ? 1 : 0,
				...actions,
				change.now
			)
	];
	// Reads the stored template, so it changes nothing when the update above did not apply.
	if (change.trigger?.type === 'link_age' || change.trigger?.type === 'clicks')
		statements.push(
			db
				.prepare(
					`UPDATE link_automations SET
						due_at = CASE link_automations.trigger_type
							WHEN 'link_age' THEN (SELECT l.created_at FROM links l WHERE l.id = link_automations.link_id) + a.trigger_days * 86400000
							WHEN 'clicks' THEN CASE WHEN link_automations.reached_clicks >= a.trigger_clicks
								THEN COALESCE(link_automations.due_at, ?3) ELSE NULL END
							ELSE link_automations.due_at END,
						updated_at = ?3
					FROM automations a
					WHERE a.id = link_automations.automation_id AND a.tenant_id = ?1
					AND link_automations.automation_id = ?2 AND link_automations.tenant_id = ?1
					AND link_automations.state = 'waiting'`
				)
				.bind(tenantId, automationId, change.now)
		);
	const [updated] = await db.batch<Record<string, unknown>>(statements);
	const row = updated.results[0];
	if (row) return { status: 'updated', automation: toAutomation(row) };
	const stored = await db
		.prepare(
			`SELECT trigger_type, (?3 IS NULL OR EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?3 AND tenant_id = ?1)) AS endpoint
			FROM automations WHERE tenant_id = ?1 AND id = ?2`
		)
		.bind(tenantId, automationId, actions[2])
		.first<Record<string, unknown>>();
	if (!stored) return { status: 'not_found' };
	if (change.trigger && stored.trigger_type !== change.trigger.type)
		return { status: 'trigger_type' };
	return stored.endpoint === 0 ? { status: 'endpoint_missing' } : { status: 'not_found' };
}

// Removes the template, its run records, and (by cascade) its applications. Returns false when
// the workspace has no such template.
export async function deleteAutomation(
	db: D1Database,
	tenantId: string,
	automationId: string
): Promise<boolean> {
	const [, automation] = await db.batch([
		db
			.prepare('DELETE FROM automation_runs WHERE automation_id = ? AND tenant_id = ?')
			.bind(automationId, tenantId),
		db
			.prepare('DELETE FROM automations WHERE id = ? AND tenant_id = ?')
			.bind(automationId, tenantId)
	]);
	// D1 counts the cascaded applications in changes too.
	return automation.meta.changes > 0;
}

export async function readAutomation(
	db: D1Database,
	tenantId: string,
	automationId: string
): Promise<AutomationRow | null> {
	const row = await db
		.prepare(
			`SELECT ${automationColumns}, ${applicationCount('a')} AS links FROM automations a WHERE tenant_id = ? AND id = ?`
		)
		.bind(tenantId, automationId)
		.first<Record<string, unknown>>();
	return row ? toAutomation(row) : null;
}

// The workspace's templates, oldest first, with the number in use and the limit. Null when
// routing holds no policy for the workspace.
export async function listAutomations(
	db: D1Database,
	tenantId: string
): Promise<{ automations: AutomationRow[]; used: number; limit: number } | null> {
	const [policy, automations] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				'SELECT COALESCE(automation_limit, 0) AS automation_limit, (SELECT COUNT(*) FROM automations WHERE tenant_id = ?1) AS used FROM tenant_policy WHERE tenant_id = ?1'
			)
			.bind(tenantId),
		db
			.prepare(
				`SELECT ${automationColumns}, ${applicationCount('a')} AS links FROM automations a WHERE tenant_id = ? ORDER BY created_at, id LIMIT 100`
			)
			.bind(tenantId)
	]);
	const row = policy.results[0];
	if (!row) return null;
	return {
		automations: automations.results.map(toAutomation),
		used: count(row.used, 'automation count'),
		limit: count(row.automation_limit, 'automation limit')
	};
}

// The templates applied to one link of the workspace, oldest application first. Empty for a
// link the workspace does not have.
export async function listLinkAutomations(
	db: D1Database,
	tenantId: string,
	linkId: string
): Promise<LinkAutomationRow[]> {
	const { results } = await db
		.prepare(
			`SELECT la.automation_id AS id, a.name, a.enabled, a.trigger_type, a.trigger_days, a.trigger_clicks,
				la.state, la.ends_at, la.due_at, la.fired_at, la.result_code, la.armed_at,
				la.last_checked_at, la.last_check_result, la.check_failures
			FROM link_automations la JOIN automations a ON a.id = la.automation_id
			WHERE la.tenant_id = ? AND la.link_id = ? ORDER BY la.created_at, la.automation_id LIMIT ${automationsPerLink * 4}`
		)
		.bind(tenantId, linkId)
		.all<Record<string, unknown>>();
	return results.map((row) => {
		const trigger = toTrigger(row);
		return {
			automationId: text(row.id, 'automation'),
			name: text(row.name, 'automation name'),
			enabled: row.enabled === 1,
			trigger,
			state: applicationState(row.state),
			endsAt: optionalCount(row.ends_at, 'end date'),
			dueAt: optionalCount(row.due_at, 'due time'),
			firedAt: optionalCount(row.fired_at, 'run time'),
			result: result(row.result_code),
			armedAt: count(row.armed_at, 'apply time'),
			check:
				trigger.type === 'destination_down'
					? {
							lastCheckedAt: optionalCount(row.last_checked_at, 'check time'),
							lastResult: optionalText(row.last_check_result, 'check result'),
							failures: count(row.check_failures, 'check failures')
						}
					: null
		};
	});
}

// The destinations of the workspace's links that are not blocked, by link ID: a
// destination_down template goes only on a link whose destination a check can request.
export async function readLinkDestinations(
	db: D1Database,
	tenantId: string,
	linkIds: readonly string[]
): Promise<Map<string, string>> {
	batchSize(linkIds.length, 100);
	const { results } = await db
		.prepare(
			`SELECT l.id, l.destination FROM json_each(?2) j
			JOIN links l ON l.id = j.value AND l.tenant_id = ?1 WHERE l.blocked_at IS NULL`
		)
		.bind(tenantId, JSON.stringify(linkIds))
		.all<Record<string, unknown>>();
	return new Map(
		results.map((row) => [text(row.id, 'link'), text(row.destination, 'destination')])
	);
}

// Applies the template to each link in one statement, which also keeps the per-link limit and
// refuses a blocked link and a workspace at automation limit 0. A finished application is
// armed again; a waiting one with the same end date is left as it is. Only when a link was not
// applied, a second read says why.
export async function applyAutomation(db: D1Database, request: ApplyRequest): Promise<ApplyResult> {
	const linkIds = [...new Set(request.linkIds)];
	batchSize(linkIds.length, 100);
	const { results } = await db
		.prepare(
			`INSERT INTO link_automations (tenant_id, link_id, automation_id, trigger_type, ends_at, due_at, armed_at, created_at, updated_at)
			SELECT ?1, l.id, a.id, a.trigger_type,
				CASE WHEN a.trigger_type = 'end_date' THEN ?4 END,
				CASE a.trigger_type WHEN 'end_date' THEN ?4 WHEN 'link_age' THEN l.created_at + a.trigger_days * 86400000 END,
				?5, ?5, ?5
			FROM json_each(?3) j
			JOIN links l ON l.id = j.value AND l.tenant_id = ?1
			JOIN automations a ON a.id = ?2 AND a.tenant_id = ?1
			JOIN tenant_policy p ON p.tenant_id = ?1
			WHERE COALESCE(p.automation_limit, 0) > 0 AND l.blocked_at IS NULL
			AND ((SELECT COUNT(*) FROM link_automations x WHERE x.link_id = l.id) < ${automationsPerLink}
				OR EXISTS (SELECT 1 FROM link_automations x WHERE x.link_id = l.id AND x.automation_id = a.id))
			ON CONFLICT(link_id, automation_id) DO UPDATE SET state = 'waiting', ends_at = excluded.ends_at,
				due_at = excluded.due_at, armed_at = excluded.armed_at, reached_clicks = NULL, claim_token = NULL,
				claimed_until = NULL, attempts = 0, check_key = NULL, check_failures = 0, last_checked_at = NULL,
				last_check_result = NULL, fired_at = NULL, result_code = NULL, updated_at = excluded.updated_at
			WHERE NOT (link_automations.state = 'waiting' AND link_automations.ends_at IS excluded.ends_at)
			RETURNING link_id`
		)
		.bind(
			request.tenantId,
			request.automationId,
			JSON.stringify(linkIds),
			request.endsAt,
			request.now
		)
		.all<{ link_id: unknown }>();
	const applied = new Set(results.map((row) => text(row.link_id, 'link')));
	const missing = linkIds.filter((id) => !applied.has(id));
	if (missing.length === 0)
		return { status: 'done', links: linkIds.map((linkId) => ({ linkId, outcome: 'applied' })) };
	const { results: reasons } = await db
		.prepare(
			`SELECT j.value AS link_id,
				EXISTS (SELECT 1 FROM automations WHERE id = ?2 AND tenant_id = ?1) AS automation,
				COALESCE((SELECT automation_limit FROM tenant_policy WHERE tenant_id = ?1), 0) AS automation_limit,
				l.id IS NOT NULL AS found, l.blocked_at IS NOT NULL AS blocked,
				EXISTS (SELECT 1 FROM link_automations x WHERE x.link_id = j.value AND x.automation_id = ?2) AS applied
			FROM json_each(?3) j LEFT JOIN links l ON l.id = j.value AND l.tenant_id = ?1`
		)
		.bind(request.tenantId, request.automationId, JSON.stringify(missing))
		.all<Record<string, unknown>>();
	const first = reasons[0];
	if (!first || first.automation === 0) return { status: 'not_found' };
	if (first.automation_limit === 0) return { status: 'off' };
	const why = new Map<string, ApplyLinkOutcome>(
		reasons.map((row) => [
			text(row.link_id, 'link'),
			row.found === 0
				? 'not_found'
				: row.blocked === 1
					? 'blocked'
					: row.applied === 1
						? 'unchanged'
						: 'link_limit'
		])
	);
	return {
		status: 'done',
		links: linkIds.map((linkId) => ({
			linkId,
			outcome: applied.has(linkId) ? 'applied' : (why.get(linkId) ?? 'not_found')
		}))
	};
}

// Records the counted clicks read from the analytics shard after applying a clicks template:
// reached_clicks keeps the highest count seen, and an application whose count meets the
// template becomes due now. Milestones moved after the apply mark the rows on their own.
export async function recordClickTotals(
	db: D1Database,
	update: {
		tenantId: string;
		automationId: string;
		totals: { linkId: string; clicks: number }[];
		now: number;
	}
): Promise<number> {
	if (update.totals.length === 0) return 0;
	batchSize(update.totals.length, 100);
	const result = await db
		.prepare(
			`UPDATE link_automations SET
				reached_clicks = max(COALESCE(link_automations.reached_clicks, 0), r.clicks),
				due_at = CASE WHEN link_automations.due_at IS NULL AND r.clicks >= a.trigger_clicks THEN ?3 ELSE link_automations.due_at END,
				updated_at = ?3
			FROM (SELECT json_extract(value, '$.linkId') AS link_id, json_extract(value, '$.clicks') AS clicks FROM json_each(?4)) AS r,
				automations a
			WHERE link_automations.link_id = r.link_id AND link_automations.tenant_id = ?1
			AND link_automations.automation_id = ?2 AND a.id = link_automations.automation_id
			AND link_automations.state = 'waiting' AND link_automations.trigger_type = 'clicks'`
		)
		.bind(update.tenantId, update.automationId, update.now, JSON.stringify(update.totals))
		.run();
	return result.meta.changes;
}

// The statement that marks waiting clicks applications with milestones moved from an analytics
// shard, for the routing batch that also writes their webhook events (milestoneEventsStatement),
// before the shard deletes them. Safe to repeat. milestones must not be empty.
export function markClickApplications(
	db: D1Database,
	milestones: ClickMilestone[],
	now: number
): D1PreparedStatement {
	batchSize(milestones.length, 100);
	return db
		.prepare(
			`UPDATE link_automations SET
				reached_clicks = max(COALESCE(link_automations.reached_clicks, 0), m.clicks),
				due_at = CASE WHEN link_automations.due_at IS NULL AND m.clicks >= a.trigger_clicks THEN ?1 ELSE link_automations.due_at END,
				updated_at = ?1
			FROM (SELECT json_extract(value, '$.tenantId') AS tenant_id, json_extract(value, '$.linkId') AS link_id,
					max(json_extract(value, '$.clicks')) AS clicks
				FROM json_each(?2) GROUP BY 1, 2) AS m,
				automations a
			WHERE link_automations.link_id = m.link_id AND link_automations.tenant_id = m.tenant_id
			AND a.id = link_automations.automation_id
			AND link_automations.state = 'waiting' AND link_automations.trigger_type = 'clicks'`
		)
		.bind(now, JSON.stringify(milestones));
}

// SQL over a link_automations row: its due application waits for no claim.
const dueUnclaimed = (la: string) =>
	`${la}.state = 'waiting' AND ${la}.due_at <= ?1 AND (${la}.claimed_until IS NULL OR ${la}.claimed_until <= ?1)`;

// One batch. First, due applications that will not run are finished: skipped for plan when the
// workspace's limit is 0, skipped for off when the template is off, failed for attempts after
// automationMaxAttempts claims (at most 100; a suspended workspace waits). Then the oldest due
// applications are claimed with token for automationLeaseMs, at most one per link, so two runs at
// once claim different ones. Off templates are never claimed. Record the skipped ones with
// recordSkippedRuns.
export async function claimAutomations(
	db: D1Database,
	options: { token: string; now: number; limit: number }
): Promise<{ claimed: ClaimedApplication[]; skipped: SkippedApplication[] }> {
	const limitOff = `COALESCE((SELECT automation_limit FROM tenant_policy WHERE tenant_id = link_automations.tenant_id), 0) = 0`;
	const templateOff = `(SELECT enabled FROM automations WHERE id = link_automations.automation_id) = 0`;
	const [skipped, claimed] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`UPDATE link_automations SET
					state = CASE WHEN ${limitOff} OR ${templateOff} THEN 'skipped' ELSE 'failed' END,
					result_code = CASE WHEN ${limitOff} THEN 'plan' WHEN ${templateOff} THEN 'off' ELSE 'attempts' END,
					fired_at = ?1, claim_token = NULL, claimed_until = NULL, updated_at = ?1
				WHERE rowid IN (SELECT la.rowid FROM link_automations la
					JOIN automations a ON a.id = la.automation_id
					LEFT JOIN tenant_policy p ON p.tenant_id = la.tenant_id
					WHERE ${dueUnclaimed('la')} AND p.suspended_at IS NULL
					AND (COALESCE(p.automation_limit, 0) = 0 OR a.enabled = 0 OR la.attempts >= ?2)
					ORDER BY la.due_at, la.rowid LIMIT 100)
				RETURNING tenant_id, link_id, automation_id, state, result_code`
			)
			.bind(options.now, automationMaxAttempts),
		db
			.prepare(
				`UPDATE link_automations SET claim_token = ?3, claimed_until = ?1 + ?5, attempts = attempts + 1, updated_at = ?1
				WHERE rowid IN (SELECT r FROM (SELECT la.rowid AS r, la.due_at AS d,
						row_number() OVER (PARTITION BY la.link_id ORDER BY la.due_at, la.rowid) AS n
					FROM link_automations la
					JOIN automations a ON a.id = la.automation_id
					JOIN tenant_policy p ON p.tenant_id = la.tenant_id
					WHERE ${dueUnclaimed('la')} AND la.attempts < ?2 AND a.enabled = 1
					AND COALESCE(p.automation_limit, 0) > 0 AND p.suspended_at IS NULL)
					WHERE n = 1 ORDER BY d, r LIMIT ?4)
				RETURNING tenant_id, link_id, automation_id`
			)
			.bind(
				options.now,
				automationMaxAttempts,
				options.token,
				batchSize(options.limit, 100),
				automationLeaseMs
			)
	]);
	const application = (row: Record<string, unknown>): ClaimedApplication => ({
		tenantId: text(row.tenant_id, 'tenant'),
		linkId: text(row.link_id, 'link'),
		automationId: text(row.automation_id, 'automation')
	});
	return {
		claimed: claimed.results.map(application),
		skipped: skipped.results.map((row) => {
			const state = applicationState(row.state);
			const code = result(row.result_code);
			if ((state !== 'skipped' && state !== 'failed') || code === null)
				throw new Error('Invalid skipped application');
			return { ...application(row), state, result: code };
		})
	};
}

// Run records for the applications claimAutomations finished without running, in one statement.
export async function recordSkippedRuns(
	db: D1Database,
	record: { token: string; now: number; skipped: SkippedApplication[] }
): Promise<number> {
	if (record.skipped.length === 0) return 0;
	batchSize(record.skipped.length, 100);
	const result = await db
		.prepare(
			`INSERT INTO automation_runs (id, tenant_id, automation_id, automation_name, link_id, claim_token, state, result_code, actions, email, created_at)
			SELECT 'run_' || lower(hex(randomblob(16))), s.tenant_id, a.id, a.name, s.link_id, ?1, s.state, s.result, '[]', 0, ?2
			FROM (SELECT json_extract(value, '$.tenantId') AS tenant_id, json_extract(value, '$.linkId') AS link_id,
				json_extract(value, '$.automationId') AS automation_id, json_extract(value, '$.state') AS state,
				json_extract(value, '$.result') AS result FROM json_each(?3)) AS s
			JOIN automations a ON a.id = s.automation_id AND a.tenant_id = s.tenant_id`
		)
		.bind(record.token, record.now, JSON.stringify(record.skipped))
		.run();
	return result.meta.changes;
}

// SQL: the claimed applications of a run (?1 items, ?2 token) with their template `a`, policy
// `p`, and link `l`. A re-apply clears the token, so an application armed again since the claim
// is not run. A workspace suspended, set to limit 0, or a template turned off since the claim
// leaves its applications for the next claim.
const runRows = `(SELECT json_extract(value, '$.linkId') AS link_id, json_extract(value, '$.automationId') AS automation_id,
		json_extract(value, '$.linkEventId') AS link_event_id, json_extract(value, '$.triggerEventId') AS trigger_event_id,
		json_extract(value, '$.runId') AS run_id FROM json_each(?1)) AS r
	JOIN link_automations la ON la.link_id = r.link_id AND la.automation_id = r.automation_id
		AND la.claim_token = ?2 AND la.state = 'waiting'
	JOIN automations a ON a.id = la.automation_id AND a.tenant_id = la.tenant_id AND a.enabled = 1
	JOIN tenant_policy p ON p.tenant_id = la.tenant_id AND COALESCE(p.automation_limit, 0) > 0 AND p.suspended_at IS NULL
	JOIN links l ON l.id = la.link_id AND l.tenant_id = la.tenant_id`;

// SQL over runRows. As updateLink: a blocked link refuses a destination change, and then no
// action runs; turning a blocked link off works.
const refused = '(l.blocked_at IS NOT NULL AND a.set_destination IS NOT NULL)';
const changesLink = `(a.set_destination IS NOT NULL OR a.disable_link = 1) AND NOT ${refused}`;
const endpointExists =
	'EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.id = a.webhook_endpoint_id AND w.tenant_id = la.tenant_id)';
const webhookSent = `a.webhook_endpoint_id IS NOT NULL AND ${endpointExists} AND COALESCE(p.webhook_endpoint_limit, 0) > 0`;
const emailed = `NOT ${refused} AND a.email_owner = 1`;
const runResult = `CASE WHEN ${refused} THEN 'link_blocked'
	WHEN a.webhook_endpoint_id IS NOT NULL AND NOT ${endpointExists} THEN 'endpoint_missing'
	WHEN a.webhook_endpoint_id IS NOT NULL AND COALESCE(p.webhook_endpoint_limit, 0) = 0 THEN 'webhooks_off' END`;

// SQL: a JSON array of the action kinds whose condition holds, in the order they run.
function actionList(conditions: Record<AutomationActionType, string>): string {
	const items = automationActionTypes
		.map((type) => `CASE WHEN ${conditions[type]} THEN '"${type}",' ELSE '' END`)
		.join(' || ');
	return `json('[' || rtrim(${items}, ',') || ']')`;
}

const triggerJson = `json(CASE a.trigger_type
	WHEN 'end_date' THEN json_object('type', 'end_date', 'endsAt', CASE WHEN la.ends_at IS NULL THEN NULL ELSE ${isoTime('la.ends_at')} END)
	WHEN 'link_age' THEN json_object('type', 'link_age', 'days', a.trigger_days)
	WHEN 'clicks' THEN json_object('type', 'clicks', 'clicks', a.trigger_clicks)
	ELSE json_object('type', 'destination_down', 'lastResult', la.last_check_result) END)`;

// Runs claimed applications in one batch of 8 statements: stage link events, change the links,
// complete and drop no-op link events (as updateLink), write each automation.triggered event for
// its target endpoint, record the runs, finish the applications, and read the email notices to
// send, one per template. Applications whose claim has ended or changed are left alone. ran is
// the number of applications finished.
export async function runAutomations(
	db: D1Database,
	run: { token: string; now: number; items: RunItem[] }
): Promise<{ ran: number; emails: AutomationEmail[] }> {
	if (run.items.length === 0) return { ran: 0, emails: [] };
	batchSize(run.items.length, 100);
	const items = JSON.stringify(
		run.items.map(({ linkId, automationId, linkEventId, triggerEventId, runId }) => ({
			linkId,
			automationId,
			linkEventId,
			triggerEventId,
			runId
		}))
	);
	const linkEventIds = "(SELECT json_extract(value, '$.linkEventId') FROM json_each(?1))";
	const previous = (field: string) => `json_extract(e.payload, '$.previous.${field}')`;
	const results = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`INSERT INTO webhook_events (id, tenant_id, type, subject_id, payload, created_at)
				SELECT r.link_event_id, la.tenant_id, 'link.updated', l.id, json_object('link', NULL, 'previous', json_object(
					'destination', l.destination, 'title', l.title, 'iosDestination', l.ios_destination,
					'androidDestination', l.android_destination, 'enabled', json(CASE l.status WHEN 'active' THEN 'true' ELSE 'false' END))), ?3
				FROM ${runRows}
				WHERE ${changesLink} AND ${webhooksOn('la.tenant_id')}`
			)
			.bind(items, run.token, run.now),
		db
			.prepare(
				`UPDATE links SET
					destination = COALESCE(c.set_destination, links.destination),
					status = CASE WHEN c.disable_link = 1 THEN 'disabled' ELSE links.status END,
					updated_at = ?3
				FROM (SELECT la.link_id, la.tenant_id, a.set_destination, a.disable_link FROM ${runRows} WHERE ${changesLink}) AS c
				WHERE links.id = c.link_id AND links.tenant_id = c.tenant_id`
			)
			.bind(items, run.token, run.now),
		// A change of the on/off state wins the type.
		db
			.prepare(
				`UPDATE webhook_events AS e SET
					payload = json_set(e.payload, '$.link', ${linkJson('l', 'n')}),
					type = CASE
						WHEN ${previous('enabled')} = (l.status = 'active') THEN 'link.updated'
						WHEN l.status = 'active' THEN 'link.enabled'
						ELSE 'link.disabled' END
				FROM links l JOIN domain_namespaces n ON n.id = l.domain_id
				WHERE e.id IN ${linkEventIds} AND l.id = e.subject_id AND l.tenant_id = e.tenant_id`
			)
			.bind(items),
		db
			.prepare(
				`DELETE FROM webhook_events AS e WHERE e.id IN ${linkEventIds} AND EXISTS (
					SELECT 1 FROM links l WHERE l.tenant_id = e.tenant_id AND l.id = e.subject_id
					AND l.destination IS ${previous('destination')}
					AND l.title IS ${previous('title')}
					AND l.ios_destination IS ${previous('iosDestination')}
					AND l.android_destination IS ${previous('androidDestination')}
					AND (l.status = 'active') = ${previous('enabled')}
				)`
			)
			.bind(items),
		// Reports the link after the change. A turned-off endpoint gets no delivery (fan-out).
		db
			.prepare(
				`INSERT INTO webhook_events (id, tenant_id, type, subject_id, target_endpoint_id, payload, created_at)
				SELECT r.trigger_event_id, la.tenant_id, 'automation.triggered', l.id, a.webhook_endpoint_id,
					json_object('automation', json_object('id', a.id, 'name', a.name, 'trigger', ${triggerJson}),
						'link', ${linkJson('l', 'n')},
						'actions', ${actionList({
							change_destination: 'a.set_destination IS NOT NULL',
							disable_link: 'a.disable_link = 1',
							send_webhook: '1',
							email_owner: 'a.email_owner = 1'
						})}), ?3
				FROM ${runRows}
				JOIN domain_namespaces n ON n.id = l.domain_id
				WHERE NOT ${refused} AND ${webhookSent}`
			)
			.bind(items, run.token, run.now),
		db
			.prepare(
				`INSERT INTO automation_runs (id, tenant_id, automation_id, automation_name, link_id, claim_token, state, result_code, actions, email, created_at)
				SELECT x.run_id, x.tenant_id, x.automation_id, x.name, x.link_id, ?2,
					CASE WHEN x.result IS NULL THEN 'succeeded' ELSE 'failed' END, x.result, x.actions, x.email, ?3
				FROM (SELECT r.run_id, la.tenant_id, a.id AS automation_id, a.name, la.link_id, ${runResult} AS result,
					${actionList({
						change_destination: `NOT ${refused} AND a.set_destination IS NOT NULL`,
						disable_link: `NOT ${refused} AND a.disable_link = 1`,
						send_webhook: `NOT ${refused} AND ${webhookSent}`,
						email_owner: emailed
					})} AS actions,
					CASE WHEN ${emailed} THEN 1 ELSE 0 END AS email
					FROM ${runRows}) AS x`
			)
			.bind(items, run.token, run.now),
		db
			.prepare(
				`UPDATE link_automations SET
					state = CASE run.state WHEN 'succeeded' THEN 'done' ELSE 'failed' END,
					result_code = run.result_code, fired_at = ?2, claim_token = NULL, claimed_until = NULL, updated_at = ?2
				FROM automation_runs AS run
				WHERE run.claim_token = ?1 AND run.link_id = link_automations.link_id
				AND run.automation_id = link_automations.automation_id
				AND link_automations.claim_token = ?1 AND link_automations.state = 'waiting'`
			)
			.bind(run.token, run.now),
		db
			.prepare(
				`SELECT g.tenant_id, g.automation_id, g.automation_name, g.links, g.failed,
					CASE WHEN g.links = 1 THEN (SELECT 'https://' || n.hostname || '/' || l.slug
						FROM links l JOIN domain_namespaces n ON n.id = l.domain_id
						WHERE l.id = g.first_link AND l.tenant_id = g.tenant_id) END AS short_url
				FROM (SELECT tenant_id, automation_id, automation_name, COUNT(*) AS links,
						SUM(state = 'failed') AS failed, MIN(link_id) AS first_link
					FROM automation_runs WHERE claim_token = ?1 AND email = 1
					GROUP BY tenant_id, automation_id, automation_name) AS g`
			)
			.bind(run.token)
	]);
	const finished = results[6];
	const emails = results[7];
	if (!finished || !emails) throw new Error('Automation run returned no result');
	return {
		ran: finished.meta.changes,
		emails: emails.results.map((row) => ({
			tenantId: text(row.tenant_id, 'tenant'),
			automationId: text(row.automation_id, 'automation'),
			automationName: text(row.automation_name, 'automation name'),
			links: count(row.links, 'run count'),
			failed: count(row.failed, 'failed run count'),
			shortUrl: optionalText(row.short_url, 'short URL')
		}))
	};
}

// The template's newest runs first, at most recentRunCount. Null when the workspace has no such
// template.
export async function listAutomationRuns(
	db: D1Database,
	tenantId: string,
	automationId: string,
	limit = recentRunCount
): Promise<AutomationRunRow[] | null> {
	const [automation, runs] = await db.batch<Record<string, unknown>>([
		db
			.prepare('SELECT 1 AS found FROM automations WHERE tenant_id = ? AND id = ?')
			.bind(tenantId, automationId),
		db
			.prepare(
				`SELECT r.id, r.link_id, r.state, r.result_code, r.actions, r.created_at,
					CASE WHEN l.id IS NULL THEN NULL ELSE 'https://' || n.hostname || '/' || l.slug END AS short_url
				FROM automation_runs r
				LEFT JOIN links l ON l.id = r.link_id AND l.tenant_id = r.tenant_id
				LEFT JOIN domain_namespaces n ON n.id = l.domain_id
				WHERE r.tenant_id = ? AND r.automation_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
			)
			.bind(tenantId, automationId, batchSize(limit, recentRunCount))
	]);
	if (automation.results.length === 0) return null;
	return runs.results.map((row) => ({
		id: text(row.id, 'run'),
		linkId: text(row.link_id, 'link'),
		shortUrl: optionalText(row.short_url, 'short URL'),
		state: runState(row.state),
		result: result(row.result_code),
		actions: storedActionTypes(row.actions),
		createdAt: count(row.created_at, 'run time')
	}));
}

// Deletes run records older than automationRunLifetimeMs, oldest first. Returns the rows deleted.
export async function deleteOldAutomationRuns(
	db: D1Database,
	now: number,
	limit: number
): Promise<number> {
	const result = await db
		.prepare(
			'DELETE FROM automation_runs WHERE id IN (SELECT id FROM automation_runs WHERE created_at < ? ORDER BY created_at LIMIT ?)'
		)
		.bind(now - automationRunLifetimeMs, batchSize(limit, 1000))
		.run();
	return result.meta.changes;
}

// Returns false when the template is not applied to the workspace's link.
export async function removeLinkAutomation(
	db: D1Database,
	tenantId: string,
	linkId: string,
	automationId: string
): Promise<boolean> {
	const result = await db
		.prepare(
			'DELETE FROM link_automations WHERE tenant_id = ? AND link_id = ? AND automation_id = ?'
		)
		.bind(tenantId, linkId, automationId)
		.run();
	return result.meta.changes === 1;
}

// Claims the destination_down applications checked longest ago (never checked first), at most
// once per destinationRecheckMs, with the link's destination. Only waiting applications that are
// not due yet, of templates that are on, in workspaces that are not suspended or at limit 0.
export async function claimDestinationChecks(
	db: D1Database,
	options: { now: number; limit: number }
): Promise<DestinationCheck[]> {
	const { results } = await db
		.prepare(
			`UPDATE link_automations SET last_checked_at = ?1
			WHERE rowid IN (SELECT la.rowid FROM link_automations la
				JOIN automations a ON a.id = la.automation_id
				JOIN tenant_policy p ON p.tenant_id = la.tenant_id
				WHERE la.state = 'waiting' AND la.trigger_type = 'destination_down' AND la.due_at IS NULL
				AND a.enabled = 1 AND COALESCE(p.automation_limit, 0) > 0 AND p.suspended_at IS NULL
				AND (la.last_checked_at IS NULL OR la.last_checked_at <= ?1 - ?2)
				ORDER BY la.last_checked_at NULLS FIRST, la.rowid LIMIT ?3)
			RETURNING tenant_id, link_id, automation_id,
				(SELECT destination FROM links WHERE id = link_automations.link_id AND tenant_id = link_automations.tenant_id) AS destination`
		)
		.bind(options.now, destinationRecheckMs, batchSize(options.limit, 100))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		tenantId: text(row.tenant_id, 'tenant'),
		linkId: text(row.link_id, 'link'),
		automationId: text(row.automation_id, 'automation'),
		destination: text(row.destination, 'destination')
	}));
}

// Records check results in one statement. A success clears the count; a failure counts on the
// same key and starts again at 1 on another. destinationFailuresToTrigger failures in a row make
// the application due now. A not_checkable result is no failure: it clears the count, and the
// application waits with that result until a later check can request the destination.
export async function finishDestinationChecks(
	db: D1Database,
	finish: { now: number; results: DestinationCheckResult[] }
): Promise<number> {
	if (finish.results.length === 0) return 0;
	batchSize(finish.results.length, 100);
	const failures = `CASE WHEN r.failed = 0 THEN 0 WHEN link_automations.check_key = r.check_key THEN link_automations.check_failures + 1 ELSE 1 END`;
	const result = await db
		.prepare(
			`UPDATE link_automations SET
				check_failures = ${failures},
				check_key = r.check_key,
				last_check_result = r.result,
				result_code = CASE WHEN r.result = 'not_checkable' THEN 'not_checkable' END,
				due_at = CASE WHEN link_automations.due_at IS NULL AND ${failures} >= ?2 THEN ?1 ELSE link_automations.due_at END,
				updated_at = ?1
			FROM (SELECT json_extract(value, '$.linkId') AS link_id, json_extract(value, '$.automationId') AS automation_id,
				json_extract(value, '$.key') AS check_key, json_extract(value, '$.failed') AS failed,
				json_extract(value, '$.result') AS result FROM json_each(?3)) AS r
			WHERE link_automations.link_id = r.link_id AND link_automations.automation_id = r.automation_id
			AND link_automations.state = 'waiting' AND link_automations.trigger_type = 'destination_down'`
		)
		.bind(finish.now, destinationFailuresToTrigger, JSON.stringify(finish.results))
		.run();
	return result.meta.changes;
}
