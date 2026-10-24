// SPDX-License-Identifier: AGPL-3.0-only
// Uploaded page images: the avatar and the background. Each image is one object under
// <tenant>/<page>/<file> in the installation's page image store (R2); the page host serves it at
// /_image/<file>. A new or removed image deletes the old object, a page deletion deletes the
// page's objects, and a workspace deletion deletes every object under the workspace's prefix.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import { previewImageTypes, sniffPreviewImage } from '@flared/contracts/links';
import type { Page, PageImageSlot } from '@flared/contracts/pages';
import { readPage, replacePageImage, type PageRow } from '@flared/data/pages';
import { ApiError } from './links';
import { getPage, type PageSettings } from './pages';
import type { PreviewImageStore } from './preview-images';

// The same part of an R2 bucket that preview images use.
export type PageImageStore = PreviewImageStore;

export function pageImageKey(tenantId: string, pageId: string, file: string): string {
	return `${tenantId}/${pageId}/${file}`;
}

function newImageFile(extension: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const id = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `${id}.${extension}`;
}

// A failed delete leaves an object that no page names; the workspace deletion removes it later.
async function deleteObjects(store: PageImageStore, keys: string | string[]): Promise<void> {
	try {
		await store.delete(keys);
	} catch {
		console.error(JSON.stringify({ event: 'page_image_delete_failed' }));
	}
}

const blocked = () => new ApiError('PAGE_BLOCKED', 'Flared blocked this page for abuse.');

// A concurrent upload or removal can change the image between the read and the swap; the swap
// then reads the new name and tries again, so the last change wins.
const swapAttempts = 3;

export interface PageImageChange {
	tenantId: string;
	pageId: string;
	slot: PageImageSlot;
	now: number;
	settings: PageSettings;
}

function current(page: PageRow, slot: PageImageSlot): string | null {
	return slot === 'avatar' ? page.avatarImage : page.backgroundImage;
}

// Stores the image, then names it on the page. Every plan may set images; the size limit is the
// route's.
export async function setPageImage(
	routing: D1Database,
	store: PageImageStore | undefined,
	change: PageImageChange & { body: Uint8Array }
): Promise<Page> {
	const { tenantId, pageId, slot, now } = change;
	if (!store)
		throw new ApiError(
			'SERVICE_UNAVAILABLE',
			'Page images are not available on this installation.'
		);
	const extension = sniffPreviewImage(change.body);
	if (!extension)
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, or WebP image.');
	let page = await readPage(routing, tenantId, pageId);
	if (!page) throw new ApiError('NOT_FOUND', 'Page not found.');
	if (page.blockedReason) throw blocked();
	const file = newImageFile(extension);
	const key = pageImageKey(tenantId, pageId, file);
	await store.put(key, change.body, {
		httpMetadata: { contentType: previewImageTypes[extension] }
	});
	for (let attempt = 0; attempt < swapAttempts; attempt += 1) {
		const previous = current(page, slot);
		if (
			await replacePageImage(routing, { tenantId, pageId, slot, from: previous, to: file, now })
		) {
			if (previous !== null) await deleteObjects(store, pageImageKey(tenantId, pageId, previous));
			return getPage(routing, tenantId, pageId, change.settings);
		}
		const latest = await readPage(routing, tenantId, pageId);
		if (!latest || latest.blockedReason) {
			await deleteObjects(store, key);
			throw latest ? blocked() : new ApiError('NOT_FOUND', 'Page not found.');
		}
		page = latest;
	}
	await deleteObjects(store, key);
	throw new ApiError('SERVICE_UNAVAILABLE', 'The image changed during the upload. Try again.');
}

// Without a store, the page stops naming the image and the object stays.
export async function removePageImage(
	routing: D1Database,
	store: PageImageStore | undefined,
	change: PageImageChange
): Promise<Page> {
	const { tenantId, pageId, slot, now } = change;
	for (let attempt = 0; attempt < swapAttempts; attempt += 1) {
		const page = await readPage(routing, tenantId, pageId);
		if (!page) throw new ApiError('NOT_FOUND', 'Page not found.');
		const previous = current(page, slot);
		if (previous === null) return getPage(routing, tenantId, pageId, change.settings);
		if (page.blockedReason) throw blocked();
		if (
			await replacePageImage(routing, { tenantId, pageId, slot, from: previous, to: null, now })
		) {
			if (store) await deleteObjects(store, pageImageKey(tenantId, pageId, previous));
			else console.error(JSON.stringify({ event: 'page_image_store_missing' }));
			return getPage(routing, tenantId, pageId, change.settings);
		}
	}
	throw new ApiError('SERVICE_UNAVAILABLE', 'The image changed. Try again.');
}

// After a page is deleted: its objects, at most two and any left by a failed delete.
export async function deletePageImages(
	store: PageImageStore,
	tenantId: string,
	pageId: string
): Promise<void> {
	try {
		const { objects } = await store.list({ prefix: `${tenantId}/${pageId}/`, limit: 100 });
		if (objects.length > 0)
			await deleteObjects(
				store,
				objects.map((object) => object.key)
			);
	} catch {
		console.error(JSON.stringify({ event: 'page_image_delete_failed' }));
	}
}

// One batch of a workspace's images, for the deletion job. Returns how many it deleted; 0 means
// none is left.
export async function deleteTenantPageImages(
	store: PageImageStore,
	tenantId: string,
	limit: number
): Promise<number> {
	const { objects } = await store.list({ prefix: `${tenantId}/`, limit });
	if (objects.length === 0) return 0;
	await store.delete(objects.map((object) => object.key));
	return objects.length;
}
