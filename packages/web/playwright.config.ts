import { defineConfig, devices } from '@playwright/test';
import { APP, HARNESS_ORIGIN, HARNESS_NO_ISOLATION_ORIGIN } from './e2e/urls.ts';

/**
 * E2E against real browsers and real engines:
 *   APP                          production build (dist/), COOP same-origin + COEP credentialless
 *   HARNESS_ORIGIN               e2e build (dist-e2e/: app + fault-injection harness), cross-origin isolated
 *   HARNESS_NO_ISOLATION_ORIGIN  the same e2e build served WITHOUT COOP/COEP (terminate-and-respawn paths)
 */
const port = (u: string): string => new URL(u).port;

export default defineConfig({
  testDir: './e2e',
  timeout: 600_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: APP, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: `pnpm exec vite preview --port ${port(APP)} --strictPort`, url: APP, reuseExistingServer: false, timeout: 120_000 },
    { command: `pnpm exec vite preview --config vite.e2e.config.ts --port ${port(HARNESS_ORIGIN)} --strictPort`, url: HARNESS_ORIGIN, reuseExistingServer: false, timeout: 120_000 },
    { command: `pnpm exec vite preview --config vite.e2e.config.ts --port ${port(HARNESS_NO_ISOLATION_ORIGIN)} --strictPort`, url: HARNESS_NO_ISOLATION_ORIGIN, reuseExistingServer: false, timeout: 120_000, env: { SUTURE_E2E_NO_ISOLATION: '1' } },
  ],
});
