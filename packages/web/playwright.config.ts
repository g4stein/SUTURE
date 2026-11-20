import { defineConfig, devices } from '@playwright/test';

/** E2E smoke test against `vite preview` (COOP same-origin + COEP credentialless, see vite.config.ts). */
export default defineConfig({
  testDir: './e2e',
  timeout: 600_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite preview',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
