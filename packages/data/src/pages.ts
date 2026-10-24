// SPDX-License-Identifier: AGPL-3.0-only
// Routing-store records for pages, their blocks, and their permanent handles.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { isBlockReason, type BlockReason } from '@flared/contracts/links';
import {
	maxPageHandles,
	pageBlockKinds,
	type PageBlockInput,
	type PageImageSlot,
	type PageBlockKind,
	type PageTheme
} from '@flared/contracts/pages';

export interface PageRow {
	id: string;
	handle: string;
	domainId: string | null;
	// The hostname of domainId, while that domain is the tenant's own and not removed.
	domainHostname: string | null;
	title: string;
	bio: string | null;
	avatarImage: string | null;
	backgroundImage: string | null;
	theme: PageTheme;
	active: boolean;
	blockedReason: BlockReason | null;
	createdAt: number;
	updatedAt: number;
}

// A stored block with what the page needs of its link: the short URL, and whether the link
// opens now (on, not blocked) and where to.
export interface PageBlockRow {
	position: number;
	kind: PageBlockKind;
	linkId: string | null;
	label: string | null;
	data: Record<string, unknown> | null;
	startsAt: number | null;
	endsAt: number | null;
	link: { shortUrl: string; destination: string; open: boolean } | null;
}

// created: the page and its handle are stored. refused: a condition failed and nothing was
// stored; the caller reads why.
export type PageWriteResult = 'done' | 'refused';

export interface NewPageRecord {
	tenantId: string;
	pageId: string;
	handle: string;
	title: string;
	bio: string | null;
	theme: PageTheme;
	blocks: PageBlockInput[];
	domainId: string | null;
	// The page uses an extra block kind or a workspace domain.
	usesExtras: boolean;
	now: number;
}

// undefined keeps a field. needsExtras: the change adds an extra block or a domain that the page
// does not have yet, so it needs page extras on the plan.
export interface PageChange {
	handle?: string;
	title?: string;
	bio?: string | null;
	theme?: PageTheme;
	blocks?: PageBlockInput[];
	domainId?: string | null;
	active?: boolean;
	needsExtras: boolean;
	now: number;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalText(value: unknown, field: string): string | null {
	if (value === null) return null;
	return text(value, field);
}

function time(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value))
		throw new Error(`Invalid stored ${field}`);
	return value;
}

function optionalTime(value: unknown, field: string): number | null {
	if (value === null) return null;
	return time(value, field);
}

function json(value: unknown, field: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(text(value, field));
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error(`Invalid stored ${field}`);
	return parsed as Record<string, unknown>;
}

const pageColumns = `p.id, p.handle, p.domain_id, p.title, p.bio, p.avatar_image, p.background_image, p.theme, p.status, p.blocked_reason, p.created_at, p.updated_at,
	(SELECT n.hostname FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE d.id = p.domain_id AND d.tenant_id = p.tenant_id AND d.state <> 'disabled') AS domain_hostname`;

function toPage(row: Record<string, unknown>): PageRow {
	if (row.status !== 'active' && row.status !== 'disabled') throw new Error('Invalid page status');
	if (row.blocked_reason !== null && !isBlockReason(row.blocked_reason))
		throw new Error('Invalid block reason');
	const theme = json(row.theme, 'theme');
	if (typeof theme.id !== 'string') throw new Error('Invalid stored theme');
	return {
		id: text(row.id, 'page'),
		handle: text(row.handle, 'handle'),
		domainId: optionalText(row.domain_id, 'domain'),
		domainHostname: optionalText(row.domain_hostname, 'hostname'),
		title: text(row.title, 'title'),
		bio: optionalText(row.bio, 'bio'),
		avatarImage: optionalText(row.avatar_image, 'avatar image'),
		backgroundImage: optionalText(row.background_image, 'background image'),
		theme: theme as PageTheme,
		active: row.status === 'active',
		blockedReason: row.blocked_reason,
		createdAt: time(row.created_at, 'creation time'),
		updatedAt: time(row.updated_at, 'update time')
	};
}

function toBlock(row: Record<string, unknown>): PageBlockRow {
	const kind = row.kind;
	if (typeof kind !== 'string' || !(pageBlockKinds as readonly string[]).includes(kind))
		throw new Error('Invalid block kind');
	const linkId = optionalText(row.link_id, 'block link');
	return {
		position: time(row.position, 'position'),
		kind: kind as PageBlockKind,
		linkId,
		label: optionalText(row.label, 'label'),
		data: row.data === null ? null : json(row.data, 'block data'),
		startsAt: optionalTime(row.starts_at, 'block start'),
		endsAt: optionalTime(row.ends_at, 'block end'),
		link:
			linkId === null || row.short_url === null
				? null
				: {
						shortUrl: text(row.short_url, 'short URL'),
						destination: text(row.destination, 'destination'),
						open: row.link_open === 1
					}
	};
}

// The columns of a stored block. data keeps the fields of the kind that have no column.
export function storedBlock(block: PageBlockInput): {
	kind: PageBlockKind;
	linkId: string | null;
	label: string | null;
	data: string | null;
	startsAt: number | null;
	endsAt: number | null;
} {
	const schedule = { startsAt: block.startsAt, endsAt: block.endsAt };
	switch (block.kind) {
		case 'button':
			return {
				kind: block.kind,
				linkId: block.linkId,
				label: block.label,
				data: null,
				...schedule
			};
		case 'header':
			return { kind: block.kind, linkId: null, label: block.label, data: null, ...schedule };
		case 'social':
			return {
				kind: block.kind,
				linkId: null,
				label: null,
				data: JSON.stringify({ links: block.links }),
				...schedule
			};
		case 'payment':
			return {
				kind: block.kind,
				linkId: block.linkId,
				label: block.label,
				data: JSON.stringify({
					provider: block.provider,
					price: block.price,
					description: block.description
				}),
				...schedule
			};
		case 'embed':
			return {
				kind: block.kind,
				linkId: null,
				label: null,
				data: JSON.stringify({ provider: block.provider, address: block.address }),
				...schedule
			};
		case 'signup':
			return {
				kind: block.kind,
				linkId: null,
				label: block.label,
				data: JSON.stringify({ buttonLabel: block.buttonLabel }),
				...schedule
			};
	}
}

// Binds the shared values up to the highest ?N the statement names. SQLite counts parameters up
// to that index, and D1 refuses a statement bound with more values than it has.
function statement(db: D1Database, sql: string, values: readonly unknown[]) {
	const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])));
	return db.prepare(sql).bind(...values.slice(0, highest));
}

function blocksJson(blocks: readonly PageBlockInput[]): string {
	return JSON.stringify(blocks.map((block, position) => ({ position, ...storedBlock(block) })));
}

// Inserts every block of ?blocks (a JSON list from blocksJson) for page ?page of tenant ?tenant.
function insertBlocks(where: string): string {
	return `INSERT INTO page_blocks (page_id, tenant_id, position, kind, link_id, label, data, starts_at, ends_at)
		SELECT ?2, ?1, json_extract(value, '$.position'), json_extract(value, '$.kind'), json_extract(value, '$.linkId'),
			json_extract(value, '$.label'), json_extract(value, '$.data'), json_extract(value, '$.startsAt'), json_extract(value, '$.endsAt')
		FROM json_each(?3) WHERE ${where}`;
}

// A handle the workspace already holds, or room for one more. ?4 is the handle.
const handleRoom = `(EXISTS (SELECT 1 FROM page_handles WHERE handle = ?4 AND tenant_id = ?1)
	OR (SELECT COUNT(*) FROM page_handles WHERE tenant_id = ?1) < ${maxPageHandles})
	AND NOT EXISTS (SELECT 1 FROM reserved_handles WHERE handle = ?4)`;

// The workspace may add a page, the handle is free for it, and the extras and the domain are
// allowed. Bound as in createPage.
const createAllowed = `EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?1)
	AND (SELECT COUNT(*) FROM pages WHERE tenant_id = ?1) < COALESCE((SELECT page_limit FROM tenant_policy WHERE tenant_id = ?1), 0)
	AND ${handleRoom}
	AND NOT (?9 = 1 AND COALESCE((SELECT page_extras FROM tenant_policy WHERE tenant_id = ?1), 0) = 0)
	AND (?10 IS NULL OR EXISTS (SELECT 1 FROM domains WHERE id = ?10 AND tenant_id = ?1 AND state <> 'disabled'))`;

// The handle is the new page's, claimed by the first statement of createPage.
const handleClaimed =
	'EXISTS (SELECT 1 FROM page_handles WHERE handle = ?4 AND page_id = ?2 AND tenant_id = ?1 AND released_at IS NULL)';

// One batch claims the handle and writes the page and its blocks, each under the same
// conditions, so the page limit cannot be passed by concurrent requests. A handle another
// workspace has, or one this workspace's other page holds, stays as it is, and nothing is
// written. A block that names another workspace's link fails the foreign key, and the batch rolls
// back.
export async function createPage(db: D1Database, record: NewPageRecord): Promise<PageWriteResult> {
	const values = [
		record.tenantId,
		record.pageId,
		blocksJson(record.blocks),
		record.handle,
		record.title,
		record.bio,
		JSON.stringify(record.theme),
		record.now,
		record.usesExtras ? 1 : 0,
		record.domainId
	];
	const results = await db.batch([
		statement(
			db,
			`INSERT INTO page_handles (handle, tenant_id, page_id, released_at, created_at)
				SELECT ?4, ?1, ?2, NULL, ?8 WHERE ${createAllowed}
				ON CONFLICT (handle) DO UPDATE SET page_id = excluded.page_id, released_at = NULL
				WHERE page_handles.tenant_id = excluded.tenant_id AND page_handles.released_at IS NOT NULL`,
			values
		),
		statement(
			db,
			`INSERT INTO pages (id, tenant_id, handle, domain_id, title, bio, theme, status, created_at, updated_at)
				SELECT ?2, ?1, ?4, ?10, ?5, ?6, ?7, 'active', ?8, ?8 WHERE ${handleClaimed} AND ${createAllowed}`,
			values
		),
		// The page count now includes the new page, so the blocks follow the page row, not the limit.
		statement(
			db,
			insertBlocks('EXISTS (SELECT 1 FROM pages WHERE id = ?2 AND tenant_id = ?1)'),
			values
		)
	]);
	return results[1].meta.changes === 1 ? 'done' : 'refused';
}

// The conditions of a page change, bound as in updatePage: the page is the tenant's and not
// blocked, new extras need page extras, and a new domain is the tenant's own. A handle change
// holds only after the first statement claimed the new handle.
const changeAllowed = `EXISTS (SELECT 1 FROM pages WHERE id = ?2 AND tenant_id = ?1 AND blocked_at IS NULL)
	AND NOT (?5 = 1 AND COALESCE((SELECT page_extras FROM tenant_policy WHERE tenant_id = ?1), 0) = 0)
	AND (?6 = 0 OR ?7 IS NULL OR EXISTS (SELECT 1 FROM domains WHERE id = ?7 AND tenant_id = ?1 AND state <> 'disabled'))`;
const newHandleHeld =
	'(?4 IS NULL OR EXISTS (SELECT 1 FROM page_handles WHERE handle = ?4 AND page_id = ?2 AND tenant_id = ?1 AND released_at IS NULL))';

// One batch: claim a new handle, release the old one, replace the blocks, then change the page
// row last, so every statement sees the same conditions. updated is false when the page is
// missing or blocked, or a condition failed; nothing then changed.
export async function updatePage(
	db: D1Database,
	tenantId: string,
	pageId: string,
	change: PageChange
): Promise<{ updated: boolean }> {
	const status = change.active === undefined ? null : change.active ? 'active' : 'disabled';
	const values = [
		tenantId,
		pageId,
		change.blocks === undefined ? null : blocksJson(change.blocks),
		change.handle ?? null,
		change.needsExtras ? 1 : 0,
		change.domainId === undefined ? 0 : 1,
		change.domainId ?? null,
		change.now,
		change.title ?? null,
		change.bio === undefined ? 0 : 1,
		change.bio ?? null,
		change.theme === undefined ? null : JSON.stringify(change.theme),
		status
	];
	const allowed = `${changeAllowed} AND ${newHandleHeld}`;
	const statements = [];
	if (change.handle !== undefined)
		statements.push(
			statement(
				db,
				`INSERT INTO page_handles (handle, tenant_id, page_id, released_at, created_at)
					SELECT ?4, ?1, ?2, NULL, ?8 WHERE ${changeAllowed} AND ${handleRoom}
					ON CONFLICT (handle) DO UPDATE SET page_id = excluded.page_id, released_at = NULL
					WHERE page_handles.tenant_id = excluded.tenant_id
						AND (page_handles.released_at IS NOT NULL OR page_handles.page_id = excluded.page_id)`,
				values
			),
			statement(
				db,
				`UPDATE page_handles SET released_at = ?8
					WHERE page_id = ?2 AND tenant_id = ?1 AND handle <> ?4 AND released_at IS NULL AND ${allowed}`,
				values
			)
		);
	if (change.blocks !== undefined)
		statements.push(
			statement(
				db,
				`DELETE FROM page_blocks WHERE page_id = ?2 AND tenant_id = ?1 AND ${allowed}`,
				values
			),
			statement(db, insertBlocks(allowed), values)
		);
	statements.push(
		statement(
			db,
			`UPDATE pages SET
					handle = COALESCE(?4, handle),
					domain_id = CASE WHEN ?6 = 1 THEN ?7 ELSE domain_id END,
					title = COALESCE(?9, title),
					bio = CASE WHEN ?10 = 1 THEN ?11 ELSE bio END,
					theme = COALESCE(?12, theme),
					status = COALESCE(?13, status),
					updated_at = ?8
				WHERE id = ?2 AND tenant_id = ?1 AND ${allowed}`,
			values
		)
	);
	const results = await db.batch(statements);
	return { updated: results[results.length - 1].meta.changes === 1 };
}

// Deletes the page and its blocks and releases its handle, which stays with the workspace. A
// blocked page stays until the operator acts.
export async function deletePage(
	db: D1Database,
	tenantId: string,
	pageId: string,
	now: number
): Promise<boolean> {
	const allowed =
		'EXISTS (SELECT 1 FROM pages WHERE id = ?2 AND tenant_id = ?1 AND blocked_at IS NULL)';
	const results = await db.batch([
		db
			.prepare(
				`UPDATE page_handles SET released_at = ?3 WHERE page_id = ?2 AND tenant_id = ?1 AND released_at IS NULL AND ${allowed}`
			)
			.bind(tenantId, pageId, now),
		db
			.prepare('DELETE FROM pages WHERE id = ?2 AND tenant_id = ?1 AND blocked_at IS NULL')
			.bind(tenantId, pageId)
	]);
	return results[1].meta.changes === 1;
}

export async function readPage(
	db: D1Database,
	tenantId: string,
	pageId: string
): Promise<PageRow | null> {
	const row = await db
		.prepare(`SELECT ${pageColumns} FROM pages p WHERE p.tenant_id = ? AND p.id = ?`)
		.bind(tenantId, pageId)
		.first<Record<string, unknown>>();
	return row ? toPage(row) : null;
}

export async function readPageBlocks(
	db: Pick<D1Database, 'prepare'>,
	tenantId: string,
	pageId: string
): Promise<PageBlockRow[]> {
	const { results } = await db
		.prepare(
			`SELECT b.position, b.kind, b.link_id, b.label, b.data, b.starts_at, b.ends_at,
				'https://' || n.hostname || '/' || l.slug AS short_url, l.destination,
				l.status = 'active' AND l.blocked_at IS NULL AS link_open
			FROM page_blocks b
			LEFT JOIN links l ON l.id = b.link_id AND l.tenant_id = b.tenant_id
			LEFT JOIN domain_namespaces n ON n.id = l.domain_id
			WHERE b.tenant_id = ? AND b.page_id = ? ORDER BY b.position`
		)
		.bind(tenantId, pageId)
		.all<Record<string, unknown>>();
	return results.map(toBlock);
}

// Newest first. The cursor is the last row's (created_at, id).
export async function listPages(
	db: D1Database,
	tenantId: string,
	options: { limit: number; after: { createdAt: number; id: string } | null }
): Promise<PageRow[]> {
	const conditions = ['p.tenant_id = ?'];
	const values: (string | number)[] = [tenantId];
	if (options.after) {
		conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
		values.push(options.after.createdAt, options.after.createdAt, options.after.id);
	}
	const { results } = await db
		.prepare(
			`SELECT ${pageColumns} FROM pages p WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
		)
		.bind(...values, options.limit)
		.all<Record<string, unknown>>();
	return results.map(toPage);
}

export interface PageLink {
	id: string;
	destination: string;
}

export const maxPageLinkReads = 100;

// The tenant's links among linkIds, with their destinations; a link of another tenant is left
// out.
export async function readPageLinks(
	db: D1Database,
	tenantId: string,
	linkIds: readonly string[]
): Promise<PageLink[]> {
	if (linkIds.length === 0) return [];
	if (linkIds.length > maxPageLinkReads) throw new Error('Too many links');
	const { results } = await db
		.prepare(
			'SELECT l.id, l.destination FROM json_each(?2) j JOIN links l ON l.id = j.value AND l.tenant_id = ?1'
		)
		.bind(tenantId, JSON.stringify([...new Set(linkIds)]))
		.all<Record<string, unknown>>();
	return results.map((row) => ({
		id: text(row.id, 'link'),
		destination: text(row.destination, 'destination')
	}));
}

// Why a create or change was refused, read after the write. The write itself decided under its
// own conditions; this only picks the message.
export interface PageRefusal {
	policy: { pageLimit: number; pageExtras: boolean } | null;
	pages: number;
	// Handles the tenant holds, current and released.
	handles: number;
	// The tenant that holds the handle, and whether a page has it now.
	handle: { tenantId: string; held: boolean; pageId: string } | null;
	handleReserved: boolean;
	domainOwned: boolean;
}

export async function readPageRefusal(
	db: D1Database,
	tenantId: string,
	handle: string | null,
	domainId: string | null
): Promise<PageRefusal> {
	const row = await db
		.prepare(
			`SELECT
				(SELECT page_limit FROM tenant_policy WHERE tenant_id = ?1) AS page_limit,
				(SELECT page_extras FROM tenant_policy WHERE tenant_id = ?1) AS page_extras,
				EXISTS (SELECT 1 FROM tenant_policy WHERE tenant_id = ?1) AS has_policy,
				(SELECT COUNT(*) FROM pages WHERE tenant_id = ?1) AS pages,
				(SELECT COUNT(*) FROM page_handles WHERE tenant_id = ?1) AS handles,
				(SELECT tenant_id FROM page_handles WHERE handle = ?2) AS handle_tenant,
				(SELECT page_id FROM page_handles WHERE handle = ?2) AS handle_page,
				(SELECT released_at IS NULL FROM page_handles WHERE handle = ?2) AS handle_held,
				EXISTS (SELECT 1 FROM reserved_handles WHERE handle = ?2) AS handle_reserved,
				EXISTS (SELECT 1 FROM domains WHERE id = ?3 AND tenant_id = ?1 AND state <> 'disabled') AS domain_owned`
		)
		.bind(tenantId, handle, domainId)
		.first<Record<string, unknown>>();
	if (!row) throw new Error('Page refusal read returned no row');
	return {
		policy:
			row.has_policy === 1
				? {
						pageLimit: typeof row.page_limit === 'number' ? row.page_limit : 0,
						pageExtras: row.page_extras === 1
					}
				: null,
		pages: time(row.pages, 'page count'),
		handles: time(row.handles, 'handle count'),
		handle:
			row.handle_tenant === null
				? null
				: {
						tenantId: text(row.handle_tenant, 'handle tenant'),
						held: row.handle_held === 1,
						pageId: text(row.handle_page, 'handle page')
					},
		handleReserved: row.handle_reserved === 1,
		domainOwned: row.domain_owned === 1
	};
}

// What a visitor's request needs of a page: the page, its blocks with their links, the analytics
// shard, and whether the plan shows the badge (no page extras).
export interface PageTarget {
	tenantId: string;
	pageId: string;
	analyticsShardId: string;
	handle: string;
	// The workspace domain whose root shows the page, while that domain is active.
	domainHostname: string | null;
	title: string;
	bio: string | null;
	avatarImage: string | null;
	backgroundImage: string | null;
	theme: PageTheme;
	badge: boolean;
	blocks: PageBlockRow[];
}

// page: shows. blocked: the operator blocked the page or suspended its workspace. moved: the
// handle was the page's until a rename less than handleRedirectMs ago; the page is at handle now.
export type PageLookup =
	{ kind: 'page'; page: PageTarget } | { kind: 'blocked' } | { kind: 'moved'; handle: string };

// How long an old handle sends visitors to the page's new handle. After that it shows not found,
// and it stays with the workspace.
export const handleRedirectMs = 90 * 86400000;

const targetColumns = `p.tenant_id, p.id, p.handle, p.title, p.bio, p.avatar_image, p.background_image, p.theme, p.status,
	t.analytics_shard_id, COALESCE(t.page_extras, 0) = 0 AS badge,
	p.blocked_at IS NOT NULL OR t.suspended_at IS NOT NULL AS blocked,
	(SELECT n.hostname FROM domains d JOIN domain_namespaces n ON n.id = d.id WHERE d.id = p.domain_id AND d.tenant_id = p.tenant_id AND d.state = 'active') AS domain_hostname`;

async function toLookup(
	db: Pick<D1Database, 'prepare'>,
	row: Record<string, unknown> | null
): Promise<PageLookup | null> {
	if (!row) return null;
	if (row.blocked === 1) return { kind: 'blocked' };
	if (row.status !== 'active') return null;
	const tenantId = text(row.tenant_id, 'tenant');
	const pageId = text(row.id, 'page');
	const theme = json(row.theme, 'theme');
	if (typeof theme.id !== 'string') throw new Error('Invalid stored theme');
	return {
		kind: 'page',
		page: {
			tenantId,
			pageId,
			analyticsShardId: text(row.analytics_shard_id, 'shard'),
			handle: text(row.handle, 'handle'),
			domainHostname: optionalText(row.domain_hostname, 'hostname'),
			title: text(row.title, 'title'),
			bio: optionalText(row.bio, 'bio'),
			avatarImage: optionalText(row.avatar_image, 'avatar image'),
			backgroundImage: optionalText(row.background_image, 'background image'),
			theme: theme as PageTheme,
			badge: row.badge === 1,
			blocks: await readPageBlocks(db, tenantId, pageId)
		}
	};
}

// Visitor reads use the primary, as redirects do, so a committed change or block is never hidden
// by replica lag. A page shows while its workspace's policy exists in routing.
export async function findPageByHandle(
	db: D1Database,
	handle: string,
	now: number
): Promise<PageLookup | null> {
	const session = db.withSession('first-primary');
	const row = await session
		.prepare(
			`SELECT ${targetColumns}, h.released_at
			FROM page_handles h
			JOIN pages p ON p.id = h.page_id AND p.tenant_id = h.tenant_id
			JOIN tenant_policy t ON t.tenant_id = p.tenant_id
			WHERE h.handle = ?`
		)
		.bind(handle)
		.first<Record<string, unknown>>();
	if (!row) return null;
	if (row.released_at !== null) {
		const releasedAt = time(row.released_at, 'release time');
		const current = text(row.handle, 'handle');
		return now - releasedAt < handleRedirectMs && current !== handle
			? { kind: 'moved', handle: current }
			: null;
	}
	return toLookup(session, row);
}

// The page at the root of an active workspace domain, of the domain's own workspace.
export async function findPageByDomain(
	db: D1Database,
	hostname: string
): Promise<PageLookup | null> {
	const session = db.withSession('first-primary');
	const row = await session
		.prepare(
			`SELECT ${targetColumns}
			FROM domain_namespaces n
			JOIN domains d ON d.id = n.id AND d.state = 'active' AND d.tenant_id IS NOT NULL
			JOIN pages p ON p.domain_id = n.id AND p.tenant_id = d.tenant_id
			JOIN tenant_policy t ON t.tenant_id = p.tenant_id
			WHERE n.hostname = ?`
		)
		.bind(hostname)
		.first<Record<string, unknown>>();
	return toLookup(session, row);
}

// Names the new image (or none) on the page only while the page still names `from` and is not
// blocked, so concurrent uploads cannot both win.
export async function replacePageImage(
	db: D1Database,
	change: {
		tenantId: string;
		pageId: string;
		slot: PageImageSlot;
		from: string | null;
		to: string | null;
		now: number;
	}
): Promise<boolean> {
	const column = change.slot === 'avatar' ? 'avatar_image' : 'background_image';
	const result = await db
		.prepare(
			`UPDATE pages SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND blocked_at IS NULL AND ${column} IS ?`
		)
		.bind(change.to, change.now, change.pageId, change.tenantId, change.from)
		.run();
	return result.meta.changes === 1;
}

// A page as the operator sees it, of any tenant, with the links its blocks open.
export interface OperatorPage extends PageRow {
	tenantId: string;
	blockedAt: number | null;
	links: { id: string; shortUrl: string; destination: string }[];
}

// The operator's lookup across tenants: the page that has or last had the handle, or the page put
// on the hostname. Disabled and blocked pages are found too.
export async function findOperatorPage(
	db: D1Database,
	address: { handle: string } | { hostname: string }
): Promise<OperatorPage | null> {
	const session = db.withSession('first-primary');
	const row = await (
		'handle' in address
			? session
					.prepare(
						`SELECT ${pageColumns}, p.tenant_id, p.blocked_at FROM page_handles h
					JOIN pages p ON p.id = h.page_id AND p.tenant_id = h.tenant_id WHERE h.handle = ?`
					)
					.bind(address.handle)
			: session
					.prepare(
						`SELECT ${pageColumns}, p.tenant_id, p.blocked_at FROM domain_namespaces n
					JOIN pages p ON p.domain_id = n.id WHERE n.hostname = ?`
					)
					.bind(address.hostname)
	).first<Record<string, unknown>>();
	if (!row) return null;
	const page = toPage(row);
	const tenantId = text(row.tenant_id, 'tenant');
	const blocks = await readPageBlocks(session, tenantId, page.id);
	const links = new Map<string, { id: string; shortUrl: string; destination: string }>();
	for (const block of blocks)
		if (block.linkId && block.link)
			links.set(block.linkId, {
				id: block.linkId,
				shortUrl: block.link.shortUrl,
				destination: block.link.destination
			});
	return {
		...page,
		tenantId,
		blockedAt: row.blocked_at === null ? null : time(row.blocked_at, 'block time'),
		links: [...links.values()]
	};
}

// Sets or clears the operator's block of a page. changed false: the page was already in that
// state, so nothing was written.
export async function setPageBlock(
	db: D1Database,
	pageId: string,
	block: { reason: BlockReason; now: number } | null
): Promise<{ tenantId: string; changed: boolean } | null> {
	const changed = await (
		block
			? db
					.prepare(
						'UPDATE pages SET blocked_at = ?, blocked_reason = ? WHERE id = ? AND blocked_at IS NULL RETURNING tenant_id'
					)
					.bind(block.now, block.reason, pageId)
			: db
					.prepare(
						'UPDATE pages SET blocked_at = NULL, blocked_reason = NULL WHERE id = ? AND blocked_at IS NOT NULL RETURNING tenant_id'
					)
					.bind(pageId)
	).first<{ tenant_id: unknown }>();
	if (changed) return { tenantId: text(changed.tenant_id, 'tenant'), changed: true };
	const existing = await db
		.prepare('SELECT tenant_id FROM pages WHERE id = ?')
		.bind(pageId)
		.first<{ tenant_id: unknown }>();
	return existing ? { tenantId: text(existing.tenant_id, 'tenant'), changed: false } : null;
}
