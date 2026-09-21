import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@oe/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
  '@oe/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
  '@oe/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
  '@oe/capture': fileURLToPath(new URL('./packages/capture/src/index.ts', import.meta.url)),
  '@oe/evidence': fileURLToPath(new URL('./packages/evidence/src/index.ts', import.meta.url)),
  '@oe/notify': fileURLToPath(new URL('./packages/notify/src/index.ts', import.meta.url)),
  '@oe/scan-runner': fileURLToPath(new URL('./workers/scan-runner/src/index.ts', import.meta.url)),
  '@oe/api': fileURLToPath(new URL('./apps/api/src/app.ts', import.meta.url)),
};

/**
 * Four separate suites so a report can say which ones ran.
 *
 * ACCEPTANCE.md: "Never state 'all tests pass' without identifying which test suites exist
 * and ran." `db` and `integration` need the disposable PostgreSQL from `npm run db:up`;
 * they fail loudly rather than skipping into a false green.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          // Real transactions, real locks: these must not race each other.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
