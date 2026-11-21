import { expect, type Page } from '@playwright/test';
import { loadDigests, scanText } from '../test/fixtures/trademark.ts';

/** Shared helpers for the Phase 4 journeys (Spec 04 §8). */

export const value = (page: Page, key: string) => page.getByTestId(`value-${key}`);

export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid: Ready');
}

/** Registers a long-task observer before any page script runs (Spec 04 tasks.md header, Req 1.5). */
export async function trackLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __longTasks: Array<{ start: number; duration: number }> };
    g.__longTasks = [];
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) g.__longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask entries are Chromium-only; other engines skip the check
    }
  });
}

/**
 * Runs `fn` and fails on any main-thread task over 50 ms that started inside it. Steering §3 scopes the rule to
 * scrolling, typing, and X-Ray rendering (not engine boot or the first document load).
 */
export async function withinFrameBudget(page: Page, label: string, fn: () => Promise<void>): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await fn();
  await page.waitForTimeout(250);
  const t1 = await page.evaluate(() => performance.now());
  const long = await page.evaluate(([a, b]) => (globalThis as unknown as { __longTasks: Array<{ start: number; duration: number }> }).__longTasks.filter((e) => e.start >= (a ?? 0) && e.start <= (b ?? 0)), [t0, t1] as const);
  const worst = long.reduce((m, e) => Math.max(m, e.duration), 0);
  console.log(`[e2e] ${label}: ${long.length} long task(s) over 50 ms${long.length > 0 ? ` (worst ${worst.toFixed(0)} ms)` : ''} in ${(t1 - t0).toFixed(0)} ms`);
  expect(long.filter((e) => e.duration > 50), `${label}: main-thread tasks over 50 ms`).toEqual([]);
  return worst;
}

/** Selects a cell through the name box and commits `raw` through the formula bar. */
export async function setCell(page: Page, key: string, raw: string): Promise<void> {
  await page.getByTestId('name-box').fill(key);
  await page.getByTestId('name-box').press('Enter');
  await expect(page.getByTestId('name-box')).toHaveValue(key);
  await page.getByTestId('formula-input').fill(raw);
  await page.getByTestId('formula-input').press('Enter');
}

/** Opens the datasets list in the drawer (whatever the drawer currently shows). */
export async function showDatasets(page: Page): Promise<void> {
  if (await page.getByTestId('table-drawer').isVisible()) await page.getByTestId('drawer-datasets').click();
  else await page.getByTestId('datasets-toggle').click();
  await expect(page.getByTestId('drawer-datasets')).toBeVisible();
}

export async function selectCell(page: Page, key: string): Promise<void> {
  await page.getByTestId('name-box').fill(key);
  await page.getByTestId('name-box').press('Enter');
  await expect(page.getByTestId('name-box')).toHaveValue(key);
}

/** Opens the telemetry popover and returns the text of one row. */
export async function telemetry(page: Page, testid: string): Promise<string> {
  const pop = page.getByTestId('telemetry-popover');
  if (!(await pop.isVisible())) await page.getByTestId('readiness-pill').click();
  const t = (await page.getByTestId(testid).textContent()) ?? '';
  await page.keyboard.press('Escape');
  return t;
}

/** Spec 04 §9 applied to the rendered DOM: visible text plus titles and accessible names, matched by digest only. */
export async function scanDomForTrademarks(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    const attrs = [...document.querySelectorAll('[title],[aria-label],[placeholder]')].flatMap((el) => ['title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a) ?? ''));
    return `${document.title}\n${document.body.innerText}\n${attrs.join('\n')}`;
  });
  return scanText(text, loadDigests()).map((h) => `line ${h.line}, column ${h.column}`);
}

export function csvFixture(): Buffer {
  const lines = ['sku,region,units,price', ...Array.from({ length: 2000 }, (_, i) => `SKU-${i % 50},${['NA', 'EU', 'APAC'][i % 3]},${1 + (i % 9)},${(5 + (i * 13) % 200) / 2}`)];
  return Buffer.from(lines.join('\n'));
}
