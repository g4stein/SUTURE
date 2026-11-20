import { expect, test, type Page } from '@playwright/test';

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function states(page: Page, testid: string): Promise<string> {
  return (await page.getByTestId(testid).getAttribute('data-state')) ?? '';
}

test('vertical slice: honest readiness, live A1 → B1 → D1, Exorcist discovers + shrinks + replays, Apply trips D1', async ({ page }) => {
  const errors = watchConsole(page);
  const seen: Record<string, string[]> = { 'pill-duckdb': [], 'pill-pyodide': [] };
  const t0 = Date.now();
  await page.goto('/');

  // 1. The grid renders immediately while engines report honest states.
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid Ready');
  await expect(page.getByTestId('row-C1')).toBeVisible();
  const gridMs = Date.now() - t0;
  const pyAtFirstPaint = await page.getByTestId('pill-pyodide').textContent();
  expect(pyAtFirstPaint).toMatch(/Python\/NumPy (Lazy|Loading)/);
  await expect(page.getByTestId('tm-coi')).toHaveText('true');

  // Track every state each engine passes through until both are ready.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    for (const id of Object.keys(seen)) {
      const s = await states(page, id);
      const list = seen[id] as string[];
      if (list[list.length - 1] !== s) list.push(s);
    }
    if ((seen['pill-duckdb'] ?? []).includes('ready') && (seen['pill-pyodide'] ?? []).includes('ready')) break;
    await page.waitForTimeout(50);
  }
  console.log(`[e2e] grid visible after ${gridMs} ms; DuckDB states ${seen['pill-duckdb']?.join(' → ')}; Pyodide states ${seen['pill-pyodide']?.join(' → ')}`);
  expect(seen['pill-duckdb']).toContain('ready');
  expect(seen['pill-pyodide']).toContain('ready');
  // "Lazy" (notLoaded) may only appear before "loading"; never after.
  for (const list of Object.values(seen)) {
    const firstLoading = list.indexOf('loading');
    expect(list.slice(firstLoading + 1)).not.toContain('notLoaded');
  }

  // 2. A1 → B1 → D1 executes live.
  await expect(page.getByTestId('value-E1')).toHaveText('table 10,000×5');
  await expect(page.getByTestId('value-A1')).toHaveText('table 12×3');
  await expect(page.getByTestId('value-B1')).toHaveText(/^\d+(\.\d+)?$/);
  await expect(page.getByTestId('value-D1')).toHaveText(/^\d+(\.\d+)?$/);
  const burn = Number(await page.getByTestId('value-B1').textContent());
  const runway = Number(await page.getByTestId('value-D1').textContent());
  expect(runway).toBeCloseTo(250000 / burn, 6);
  for (const id of ['runway-finite', 'runway-defined', 'runway-non-negative']) await expect(page.getByTestId(`assert-${id}`)).toHaveAttribute('data-ok', 'true');
  const validator = await page.getByTestId('tm-validator').textContent();
  const versions = await page.getByTestId('tm-versions').textContent();
  console.log(`[e2e] B1 projected burn ${burn}; D1 runway ${runway}; validator ${validator}; DuckDB init ${await page.getByTestId('tm-duckdb-ms').textContent()}; Pyodide init ${await page.getByTestId('tm-pyodide-ms').textContent()}; ${versions}`);

  // A live edit recomputes the whole chain (C2 → A1 → B1 → D1).
  await page.getByTestId('input-C2').fill('1.5');
  await page.getByTestId('input-C2').press('Enter');
  await expect(page.getByTestId('value-B1')).not.toHaveText(String(burn));
  await page.getByTestId('input-C2').fill('1');
  await page.getByTestId('input-C2').press('Enter');
  await expect(page.getByTestId('value-B1')).toHaveText(String(burn));

  // 3. Exorcist discovers and shrinks a real counterexample across the batched chain.
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 480_000 });
  const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
  expect(violated).toMatch(/^runway-(finite|defined|non-negative):/);
  await expect(page.getByTestId('verdict-mode')).toHaveText('batched');
  const inputs = (await page.getByTestId('failing-inputs').textContent()) ?? '';
  console.log(`[e2e] Exorcist: ${await page.getByTestId('exorcist-status').textContent()} — ${violated} — shrunk ${inputs} — seed/path ${await page.getByTestId('verdict-seed').textContent()}`);
  expect(inputs).toMatch(/C1 = .+, C2 = .+/);

  // 4. "Apply Counterexample" recomputes A1 → B1 → D1 live and trips the exact assertion.
  await page.getByTestId('apply-counterexample').click();
  const tripped = violated.split(':')[0] ?? '';
  await expect(page.getByTestId(`assert-${tripped}`)).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');
  console.log(`[e2e] after Apply: B1 = ${await page.getByTestId('value-B1').textContent()}, D1 = ${await page.getByTestId('value-D1').textContent()}`);

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
