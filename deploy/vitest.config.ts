// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: { include: ['deploy/tests/**/*.test.ts'], environment: 'node', testTimeout: 30000 }
});
