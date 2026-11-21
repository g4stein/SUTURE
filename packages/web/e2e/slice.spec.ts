import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from './console.ts';

async function state(page: Page, testid: string): Promise<string> {
  return (await page.getByTestId(testid).getAttribute('data-state')) ?? '';
}

const v = (page: Page, key: string) => page.getByTestId(`value-${key}`);

test('vertical slice: honest readiness, live A1 → B1 → D1, Exorcist discovers + shrinks + replays, Apply trips D1', async ({ page }) => {
  const errors = watchConsole(page);
  const seen: Record<string, string[]> = { 'pill-duckdb': [], 'pill-pyodide': [] };
  const t0 = Date.now();
  await page.goto('/');

  // 1. The grid renders immediately while engines report honest states.
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid Ready');
  await expect(page.getByTestId('row-Slice!C1')).toBeVisible();
  const gridMs = Date.now() - t0;
  expect(await page.getByTestId('pill-pyodide').textContent()).toMatch(/Python\/NumPy (Lazy|Loading)/);
  await expect(page.getByTestId('tm-coi')).toHaveText('true');

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    for (const id of Object.keys(seen)) {
      const s = await state(page, id);
      const list = seen[id] as string[];
      if (list[list.length - 1] !== s) list.push(s);
    }
    if ((seen['pill-duckdb'] ?? []).includes('ready') && (seen['pill-pyodide'] ?? []).includes('ready')) break;
    await page.waitForTimeout(50);
  }
  console.log(`[e2e] grid visible after ${gridMs} ms; DuckDB states ${seen['pill-duckdb']?.join(' → ')}; Pyodide states ${seen['pill-pyodide']?.join(' → ')}`);
  expect(seen['pill-duckdb']).toContain('ready');
  expect(seen['pill-pyodide']).toContain('ready');
  for (const list of Object.values(seen)) expect(list.slice(list.indexOf('loading') + 1)).not.toContain('notLoaded');

  // 2. A1 → B1 → D1 executes live.
  await expect(v(page, 'Slice!E1')).toHaveText('table 10,000×5');
  await expect(v(page, 'Slice!A1')).toHaveText('table 12×3');
  await expect(v(page, 'Slice!B1')).toHaveText(/^\d+(\.\d+)?$/);
  await expect(v(page, 'Slice!D1')).toHaveText(/^\d+(\.\d+)?$/);
  const burn = Number(await v(page, 'Slice!B1').textContent());
  const runway = Number(await v(page, 'Slice!D1').textContent());
  expect(runway).toBeCloseTo(250000 / burn, 6);
  for (const id of ['runway-finite', 'runway-defined', 'runway-non-negative']) await expect(page.getByTestId(`assert-${id}`)).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('tm-first-eval-ms')).toHaveText(/\d+ ms/);
  console.log(`[e2e] B1 ${burn}; D1 ${runway}; validator ${await page.getByTestId('tm-validator').textContent()}; cold boot DuckDB ${await page.getByTestId('tm-duckdb-ms').textContent()}, Pyodide ${await page.getByTestId('tm-pyodide-ms').textContent()}; first eval ${await page.getByTestId('tm-first-eval-ms').textContent()}`);

  // A live edit recomputes the whole chain (C2 → A1 → B1 → D1) — a warm evaluation, no engine boot.
  await page.getByTestId('input-Slice!C2').fill('1.5');
  await page.getByTestId('input-Slice!C2').press('Enter');
  await expect(v(page, 'Slice!B1')).not.toHaveText(String(burn));
  await page.getByTestId('input-Slice!C2').fill('1');
  await page.getByTestId('input-Slice!C2').press('Enter');
  await expect(v(page, 'Slice!B1')).toHaveText(String(burn));
  await expect(page.getByTestId('tm-warm-eval-ms')).toHaveText(/\d+ ms/);
  console.log(`[e2e] warm DAG eval (C2 edit → A1 → B1 → D1): ${await page.getByTestId('tm-warm-eval-ms').textContent()}`);

  // 3. Exorcist discovers and shrinks a real counterexample across the batched chain.
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 480_000 });
  const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
  expect(violated).toMatch(/^runway-(finite|defined|non-negative):/);
  await expect(page.getByTestId('verdict-mode')).toHaveText('batched');
  const inputs = (await page.getByTestId('failing-inputs').textContent()) ?? '';
  console.log(`[e2e] slice Exorcist: ${await page.getByTestId('exorcist-status').textContent()} — ${violated} — shrunk ${inputs}`);
  expect(inputs).toMatch(/Slice!C1 = .+, Slice!C2 = .+/);

  // 4. "Apply Counterexample" recomputes A1 → B1 → D1 live and trips the exact assertion.
  await page.getByTestId('apply-counterexample').click();
  await expect(page.getByTestId(`assert-${violated.split(':')[0] ?? ''}`)).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');

  // 5. The replay link reproduces the exact counterexample in a fresh page.
  const href = (await page.getByTestId('replay-link').getAttribute('href')) ?? '';
  expect(href.startsWith('#replay=v1.')).toBe(true);
  const fresh = await page.context().newPage();
  const freshErrors = watchConsole(fresh);
  await fresh.goto(`/${href}`);
  await expect(fresh.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 300_000 });

  expect(errors, errors.join('\n')).toEqual([]);
  expect(freshErrors, freshErrors.join('\n')).toEqual([]);
});
