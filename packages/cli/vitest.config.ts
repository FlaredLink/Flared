// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: { include: ['packages/cli/tests/**/*.test.ts'], environment: 'node' }
});
