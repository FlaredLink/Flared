// SPDX-License-Identifier: AGPL-3.0-only
declare module '*.sql?raw' {
	const source: string;
	export default source;
}
