// SPDX-License-Identifier: AGPL-3.0-only
// QR codes for short URLs, as SVG text or a 1-bit PNG. Black on white, error correction M, and
// a quiet zone of 4 modules. Runs in Workers, browsers, and Node 18 or later.
import { correction, generate, type Bitmap2D } from 'lean-qr';

export type QrFormat = 'svg' | 'png';
export const qrFormats: readonly QrFormat[] = ['svg', 'png'];
export const defaultQrSize = 512;
export const minQrSize = 128;
export const maxQrSize = 2048;
const quietZone = 4;

// The modules of the code: true is dark.
export function qrMatrix(text: string): Bitmap2D {
	return generate(text, { minCorrectionLevel: correction.M });
}

// One path of unit squares. The text is a URL, so nothing user-supplied enters the markup.
export function qrSvg(text: string, size = defaultQrSize): string {
	const code = qrMatrix(text);
	const span = code.size + quietZone * 2;
	let path = '';
	for (let y = 0; y < code.size; y += 1)
		for (let x = 0; x < code.size; x += 1)
			if (code.get(x, y)) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${span}" height="${span}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// The image is size × size pixels; each module gets a whole number of pixels, and the rest
// widens the white margin evenly.
export async function qrPng(text: string, size = defaultQrSize): Promise<Uint8Array> {
	const code = qrMatrix(text);
	const span = code.size + quietZone * 2;
	const scale = Math.max(1, Math.floor(size / span));
	const width = Math.max(size, span * scale);
	const offset = Math.floor((width - code.size * scale) / 2);
	const rowBytes = Math.ceil(width / 8);
	// Each row: filter byte 0, then 1 bit per pixel where 1 is white.
	const raw = new Uint8Array((rowBytes + 1) * width);
	for (let y = 0; y < width; y += 1) {
		const row = y * (rowBytes + 1);
		const moduleY = Math.floor((y - offset) / scale);
		for (let x = 0; x < width; x += 1) {
			const moduleX = Math.floor((x - offset) / scale);
			const dark =
				x >= offset &&
				y >= offset &&
				moduleX < code.size &&
				moduleY < code.size &&
				code.get(moduleX, moduleY);
			if (!dark) raw[row + 1 + (x >> 3)] |= 0x80 >> (x & 7);
		}
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, width);
	header.set([1, 0, 0, 0, 0], 8); // bit depth 1, grayscale, deflate, no filter, no interlace
	return concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', await deflate(raw)),
		chunk('IEND', new Uint8Array(0))
	]);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
