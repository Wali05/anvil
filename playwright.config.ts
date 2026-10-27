import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4319',
    // Installed Edge by default (Windows dev box); ANVIL_E2E_BROWSER=bundled uses Playwright's own Chromium.
    ...(process.env.ANVIL_E2E_BROWSER === 'bundled' ? {} : { channel: 'msedge' as const }),
    ...(process.env.ANVIL_E2E_EXECUTABLE ? { launchOptions: { executablePath: process.env.ANVIL_E2E_EXECUTABLE } } : {}),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ANVIL_PORT: '4319',
      ANVIL_HOST: '127.0.0.1',
      ANVIL_DATA_DIR: '.anvil-e2e',
    },
  },
});