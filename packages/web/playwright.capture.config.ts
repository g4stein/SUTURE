import { defineConfig, devices } from '@playwright/test';

/** `pnpm capture:hero`: renders the README hero image from the production build (see capture/hero.capture.ts). */
const PORT = 4180;
export default defineConfig({
  testDir: './capture',
  testMatch: /\.capture\.ts$/,
  timeout: 600_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } }],
  webServer: { command: `pnpm exec vite preview --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 120_000 },
});
