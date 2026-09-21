import { defineConfig, devices } from '@playwright/test';

/**
 * Browser acceptance for the operator.
 *
 * TEST_PLAN.md: "Playwright fixture site and application in local isolated environment;
 * operator-to-report path plus negative states." The suite drives the real API against the
 * disposable database, so it exercises authentication, the ledger and the runner rather
 * than a mocked front end.
 *
 * `npm run db:up && npm run db:migrate && npm run db:seed` must have run first. The web
 * servers are started here so a failed run cannot leave a half-configured stack behind.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    { name: 'narrow', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'npm run fixtures',
      url: 'http://127.0.0.1:4179/product',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:4174/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:runner',
      // Its own health port: pointing this at the API's health would let Playwright decide
      // the runner is already up when only the API is, and every scan would sit queued.
      url: 'http://127.0.0.1:4175/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npx vite --config apps/operator/vite.config.ts',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
