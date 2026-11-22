import { expect, test } from '@playwright/test';
import { watchConsole } from './console.ts';
import { openApp, telemetry, value } from './app.ts';

/**
 * Spec 04 Req 10.1 in a real browser, for both flagships: the base case holds, the Exorcist discovers the flaw from a
 * fresh unscripted seed, Apply Counterexample trips the expected assertion, and the replay link reproduces it exactly.
 * The test source contains no input values, counterexamples, or seeds.
 */
const CASES = [
  { id: 'saas', title: 'SaaS Cash Runway & Unit Economics', expected: 'runway-non-negative', sheet: 'Model', base: ['Model!B4', 'Model!B5'], budgetMs: 30_000 },
  { id: 'ecommerce', title: '100,000-Row E-Commerce Margin Audit', expected: 'hardlines-stacked-net-margin', sheet: 'Margins', base: ['Margins!B5', 'Margins!B9'], budgetMs: 60_000 },
] as const;

for (const c of CASES) {
  test(`${c.title}: fresh-seed discovery, Apply Counterexample, exact replay`, async ({ page }) => {
    const errors = watchConsole(page);
    await openApp(page);
    await page.getByTestId('workbook-picker').selectOption(c.id);
    await expect(page).toHaveTitle(`${c.title} — Suture X-Ray Studio`);
    await page.getByTestId(`sheet-tab-${c.sheet}`).click();
    for (const k of c.base) await expect(value(page, k)).toHaveAttribute('data-raw', /^-?\d[\d.e+-]*$/, { timeout: 240_000 });
    await page.getByTestId('panel-tab-assertions').click();
    await expect(page.locator('[data-testid^="assert-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="assert-"][data-ok="true"]')).toHaveCount(3, { timeout: 240_000 });
    const base = await Promise.all(c.base.map(async (k) => `${k} = ${await value(page, k).getAttribute('data-raw')}`));
    console.log(`[e2e] ${c.title}: base case ${base.join(', ')}; first eval ${await telemetry(page, 'tm-first-eval-ms')}`);

    const t0 = Date.now();
    await page.getByTestId('run-exorcist').click();
    await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
    const ms = Date.now() - t0;
    const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
    console.log(`[e2e] ${c.title}: browser discovery in ${ms} ms (${await page.getByTestId('exorcist-status').textContent()}) — ${violated} — shrunk ${await page.getByTestId('failing-inputs').textContent()} — seed/path ${await page.getByTestId('verdict-seed').textContent()}`);
    expect(violated.startsWith(`${c.expected}:`)).toBe(true);
    await expect(page.getByTestId('verdict-mode')).toHaveAttribute('data-mode', 'batched');
    expect(ms).toBeLessThan(c.budgetMs);

    await page.getByTestId('apply-counterexample').click();
    await page.getByTestId('panel-tab-assertions').click();
    await expect(page.getByTestId(`assert-${c.expected}`)).toHaveAttribute('data-ok', 'false', { timeout: 60_000 });
    await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');

    await page.getByTestId('panel-tab-audit').click();
    const href = (await page.getByTestId('replay-link').getAttribute('href')) ?? '';
    const fresh = await page.context().newPage();
    const freshErrors = watchConsole(fresh);
    await fresh.goto(`/${href}`);
    await expect(fresh).toHaveTitle(`${c.title} — Suture X-Ray Studio`);
    await expect(fresh.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 300_000 });
    expect(errors, errors.join('\n')).toEqual([]);
    expect(freshErrors, freshErrors.join('\n')).toEqual([]);
  });
}
