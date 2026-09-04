import {defineConfig, devices} from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: {baseURL: 'http://app.localhost:4173', trace: 'retain-on-failure', serviceWorkers: 'allow'},
  webServer: {command: 'node scripts/test-server.mjs', url: 'http://api.localhost:8787/healthz', reuseExistingServer: false, timeout: 120_000},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
    {name: 'firefox', use: {...devices['Desktop Firefox']}},
    {name: 'webkit', use: {...devices['Desktop Safari']}}
  ]
});
