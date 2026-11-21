import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from './console.ts';

/** Both flagships in a real browser: base case holds, Exorcist discovers the flaw from a fresh seed, Apply trips it, replay is exact. */
const CASES = [
  { id: 'saas', title: 'SaaS Cash Runway & Unit Economics', expected: 'runway-non-negative', base: ['Model!B4', 'Model!B5'], budgetMs: 30_000 },
  { id: 'ecommerce', title: '100,000-Row E-Commerce Margin Audit', expected: 'hardlines-stacked-net-margin', base: ['Margins!B5', 'Margins!B9'], budgetMs: 60_000 },
] as const;

async function waitAssertionsGreen(page: Page, n: number): Promise<void> {
  await expect(page.locator('[data-testid^="assert-"]')).toHaveCount(n, { timeout: 240_000 });
  await expect(page.locator('[data-testid^="assert-"][data-ok="true"]')).toHaveCount(n, { timeout: 240_000 });
}

for (const c of CASES) {
  test(`${c.title}: fresh-seed discovery, Apply Counterexample, exact replay`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('pill-grid')).toHaveText('Grid Ready');
    await page.getByTestId('workbook-picker').selectOption(c.id);
    await expect(page.getByTestId('workbook-title')).toHaveText(c.title);
    await waitAssertionsGreen(page, 3);
    const base = await Promise.all(c.base.map(async (k) => `${k} = ${await page.getByTestId(`value-${k}`).textContent()}`));
    console.log(`[e2e] ${c.title}: base case ${base.join(', ')}; first eval ${await page.getByTestId('tm-first-eval-ms').textContent()}`);

    const t0 = Date.now();
    await page.getByTestId('run-exorcist').click();
    await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
    const ms = Date.now() - t0;
    const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
    console.log(`[e2e] ${c.title}: browser discovery in ${ms} ms (${await page.getByTestId('exorcist-status').textContent()}) — ${violated} — shrunk ${await page.getByTestId('failing-inputs').textContent()} — seed/path ${await page.getByTestId('verdict-seed').textContent()}`);
    expect(violated.startsWith(`${c.expected}:`)).toBe(true);
    await expect(page.getByTestId('verdict-mode')).toHaveText('batched');
    expect(ms).toBeLessThan(c.budgetMs);

    await page.getByTestId('apply-counterexample').click();
    await expect(page.getByTestId(`assert-${c.expected}`)).toHaveAttribute('data-ok', 'false');
    await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');

    const href = (await page.getByTestId('replay-link').getAttribute('href')) ?? '';
    const fresh = await page.context().newPage();
    const freshErrors = watchConsole(fresh);
    await fresh.goto(`/${href}`);
    await expect(fresh.getByTestId('workbook-title')).toHaveText(c.title);
    await expect(fresh.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 300_000 });
    expect(errors, errors.join('\n')).toEqual([]);
    expect(freshErrors, freshErrors.join('\n')).toEqual([]);
  });
}
