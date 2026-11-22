import { expect, test } from '@playwright/test';
import { watchConsole } from './console.ts';
import { expectLanding, openApp, rawNumber, value } from './app.ts';

/**
 * Cross-browser smoke (WebKit and Firefox projects only; Chromium runs the full suite). The judge's path on the
 * production build: the landing KPI evaluates through DuckDB-WASM, Pyodide + NumPy, and formulas; Exorcise Model finds
 * the flaw from a fresh seed; Apply Counterexample trips it; X-Ray draws the crimson fracture. WebKit does not support
 * COEP `credentialless`, so it runs in the honest degraded mode (no SharedArrayBuffer): that must still work end to end.
 */
test('judge path: landing KPI, Exorcise, Apply Counterexample, X-Ray fracture', async ({ page, browserName }) => {
  const errors = watchConsole(page);
  await openApp(page);
  await expectLanding(page, 'Model!B5');
  const runway = await rawNumber(page, 'Model!B5');
  expect(runway).toBeGreaterThan(0);
  await expect(page.getByTestId('cell-Model!B4')).toContainText('PY');
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  await expect(page.getByTestId('pill-duckdb')).toHaveAttribute('data-state', isolated ? 'ready' : 'degraded');
  await expect(page.getByTestId('pill-pyodide')).toHaveAttribute('data-state', isolated ? 'ready' : 'degraded');

  const t0 = Date.now();
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('violated-assertion')).toContainText('runway-non-negative');
  console.log(`[e2e] ${browserName} (crossOriginIsolated ${isolated}): discovery ${Date.now() - t0} ms`);

  await page.getByTestId('apply-counterexample').click();
  await expect(value(page, 'Model!B5')).toHaveText(/^-|#DIV\/0!/, { timeout: 60_000 });
  await expect(page.getByTestId('xray-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('[data-testid="xray-fracture"]').count()).toBeGreaterThan(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
