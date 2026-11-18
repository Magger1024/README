import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'e2e.spec.js',
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    serviceWorkers: 'allow',
  },
  webServer: {
    command: 'node tests/serve.js',
    url: 'http://127.0.0.1:4173/README/blockwalk/',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
