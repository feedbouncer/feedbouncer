import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './site.config';

const ORIGIN = 'http://127.0.0.1:3210';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: { baseURL: ORIGIN, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve-build.mjs 3210 127.0.0.1',
    url: ORIGIN + BASE_URL,
    reuseExistingServer: false,
  },
});
