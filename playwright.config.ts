import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  projects: [
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        hasTouch: true,
        isMobile: true,
        viewport: { height: 844, width: 390 },
      },
    },
  ],
  reporter: 'line',
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
});
