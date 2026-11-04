import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Tests execute against TypeScript sources through path aliases so that a full
 * `tsc -b` is not required before running the suite.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@omni-relay\/shared-types$/,
        replacement: resolvePath('./packages/shared-types/src/index.ts'),
      },
      { find: /^@omni-relay\/core$/, replacement: resolvePath('./packages/core/src/index.ts') },
      { find: /^@omni-relay\/rules$/, replacement: resolvePath('./packages/rules/src/index.ts') },
      {
        find: /^@omni-relay\/storage$/,
        replacement: resolvePath('./packages/storage/src/index.ts'),
      },
      { find: /^@omni-relay\/queue$/, replacement: resolvePath('./packages/queue/src/index.ts') },
      {
        find: /^@omni-relay\/capabilities$/,
        replacement: resolvePath('./packages/capabilities/src/index.ts'),
      },
      {
        find: /^@omni-relay\/onebot$/,
        replacement: resolvePath('./packages/onebot/src/index.ts'),
      },
      {
        find: /^@omni-relay\/adapters-discord$/,
        replacement: resolvePath('./packages/adapters-discord/src/index.ts'),
      },
      {
        find: /^@omni-relay\/adapters-qq$/,
        replacement: resolvePath('./packages/adapters-qq/src/index.ts'),
      },
      { find: /^@omni-relay\/server$/, replacement: resolvePath('./apps/server/src/index.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
