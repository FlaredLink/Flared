// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
// The root is this folder, so the tests run from the repository root or from packages/cli.
export default defineConfig({
	root: dirname(fileURLToPath(import.meta.url)),
	test: { include: ['tests/**/*.test.ts'], environment: 'node' }
});
