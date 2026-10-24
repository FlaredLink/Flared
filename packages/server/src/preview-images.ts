// SPDX-License-Identifier: AGPL-3.0-only
// Uploaded preview images. Each image is one object under <tenant>/<link>/<file> in the
// installation's image store (R2 in both editions); the redirect handler serves it on the link's
// own short-link host. A new or removed image deletes the old object, and a workspace deletion
// deletes every object under the workspace's prefix.
import type { D1Database } from '@cloudflare/workers-types/index.ts';
import {
	previewImageTypes,
	sniffPreviewImage,
	type Link,
	type PreviewImageExtension
} from '@flared/contracts/links';
import { readLink, replacePreviewImage } from '@flared/data/links';
import { readLinkPreviews } from '@flared/data/routing-policy';
import { ApiError, getLink, linkPreviewRefused } from './links';

// The part of an R2 bucket that previews use, so a test or another store can stand in for it.
export interface PreviewImageStore {
	put(
		key: string,
		value: Uint8Array,
		options: { httpMetadata: { contentType: string } }
	): Promise<unknown>;
	get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options: { prefix: string; limit: number }): Promise<{ objects: { key: string }[] }>;
}

export function previewImageKey(tenantId: string, linkId: string, file: string): string {
	return `${tenantId}/${linkId}/${file}`;
}

function newImageFile(extension: PreviewImageExtension): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const id = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `${id}.${extension}`;
}

// A failed delete leaves an object that no link names; the workspace deletion removes it later.
async function deleteObject(store: PreviewImageStore, key: string): Promise<void> {
	try {
		await store.delete(key);
	} catch {
		console.error(JSON.stringify({ event: 'preview_image_delete_failed' }));
	}
}

const blocked = () =>
	new ApiError('LINK_BLOCKED', 'Flared blocked this link for abuse. You can only turn it off.');

// A concurrent upload or removal can change the image between the read and the swap; the swap
// then reads the new name and tries again, so the last change wins.
const swapAttempts = 3;

export interface PreviewImageChange {
	tenantId: string;
	linkId: string;
	now: number;
}

// Stores the image, then names it on the link. The size limit is the route's.
export async function setPreviewImage(
	routing: D1Database,
	store: PreviewImageStore | undefined,
	change: PreviewImageChange & { body: Uint8Array }
): Promise<Link> {
	const { tenantId, linkId, now } = change;
	if (!store)
		throw new ApiError(
			'SERVICE_UNAVAILABLE',
			'Preview images are not available on this installation.'
		);
	const extension = sniffPreviewImage(change.body);
	if (!extension)
		throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, or WebP image.');
	let link = await readLink(routing, tenantId, linkId);
	if (!link) throw new ApiError('NOT_FOUND', 'Link not found.');
	if (link.blockedReason) throw blocked();
	if (!(await readLinkPreviews(routing, tenantId))) throw linkPreviewRefused();
	const file = newImageFile(extension);
	const key = previewImageKey(tenantId, linkId, file);
	await store.put(key, change.body, {
		httpMetadata: { contentType: previewImageTypes[extension] }
	});
	for (let attempt = 0; attempt < swapAttempts; attempt += 1) {
		const previous = link.previewImage;
		if (await replacePreviewImage(routing, { tenantId, linkId, from: previous, to: file, now })) {
			if (previous !== null) await deleteObject(store, previewImageKey(tenantId, linkId, previous));
			return getLink(routing, tenantId, linkId);
		}
		const current = await readLink(routing, tenantId, linkId);
		const refusal = !current
			? new ApiError('NOT_FOUND', 'Link not found.')
			: current.blockedReason
				? blocked()
				: !(await readLinkPreviews(routing, tenantId))
					? linkPreviewRefused()
					: null;
		if (!current || refusal) {
			await deleteObject(store, key);
			throw refusal;
		}
		link = current;
	}
	await deleteObject(store, key);
	throw new ApiError('SERVICE_UNAVAILABLE', 'The image changed during the upload. Try again.');
}

// Removing needs no plan. Without a store, the link stops naming the image and the object stays.
export async function removePreviewImage(
	routing: D1Database,
	store: PreviewImageStore | undefined,
	change: PreviewImageChange
): Promise<Link> {
	const { tenantId, linkId, now } = change;
	for (let attempt = 0; attempt < swapAttempts; attempt += 1) {
		const link = await readLink(routing, tenantId, linkId);
		if (!link) throw new ApiError('NOT_FOUND', 'Link not found.');
		if (link.previewImage === null) return getLink(routing, tenantId, linkId);
		if (link.blockedReason) throw blocked();
		const previous = link.previewImage;
		if (await replacePreviewImage(routing, { tenantId, linkId, from: previous, to: null, now })) {
			if (store) await deleteObject(store, previewImageKey(tenantId, linkId, previous));
			else console.error(JSON.stringify({ event: 'preview_image_store_missing' }));
			return getLink(routing, tenantId, linkId);
		}
	}
	throw new ApiError('SERVICE_UNAVAILABLE', 'The image changed. Try again.');
}

// One batch of a workspace's images, for the deletion job. Returns how many it deleted; 0 means
// none is left.
export async function deleteTenantPreviewImages(
	store: PreviewImageStore,
	tenantId: string,
	limit: number
): Promise<number> {
	const { objects } = await store.list({ prefix: `${tenantId}/`, limit });
	if (objects.length === 0) return 0;
	await store.delete(objects.map((object) => object.key));
	return objects.length;
}
