import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * README hero image (not part of the test suite): Flagship 1 after Exorcise Model and Apply Counterexample, with the
 * X-Ray crimson fracture, the lineage strip, and the Audit Studio verdict. Run with `pnpm --filter @suture/web
 * capture:hero`; it writes docs/hero.png at the repository root. The seed is fresh, so the shrunk inputs vary.
 */
const OUT = fileURLToPath(new URL('../../../docs/hero.png', import.meta.url));

test('capture the README hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid: Ready');
  await expect(page.getByTestId('value-Model!B5')).toHaveAttribute('data-raw', /\d/, { timeout: 180_000 });
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
  await page.getByTestId('apply-counterexample').click();
  await expect(page.getByTestId('value-Model!B6')).toHaveText('RAISE NOW', { timeout: 60_000 });
  await expect(page.getByTestId('xray-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: OUT });
});
