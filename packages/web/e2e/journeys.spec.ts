import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import type { Workbook } from 'exceljs';
import { watchConsole } from './console.ts';
import { csvFixture, expectLanding, openApp, rawNumber, scanDomForTrademarks, selectCell, setCell, telemetry, trackLongTasks, value, withinFrameBudget } from './app.ts';
import { HARNESS_NO_ISOLATION_ORIGIN } from './urls.ts';
import { CREW_REPLAY_FRAGMENT, CREW_VIOLATED_ASSERTION } from './fixtures/crewReplay.ts';

/**
 * Phase 4 journeys (Spec 04 §8, Req 1–7, 11). Real engines, real files, production build behind COOP same-origin +
 * COEP credentialless. Every journey fails on any console error.
 */
const require = createRequire(import.meta.url);
const { Workbook: XlsxWorkbook } = require('exceljs/dist/exceljs.min.js') as { Workbook: new () => Workbook };

async function xlsxFixture(): Promise<Buffer> {
  const wb = new XlsxWorkbook();
  const ws = wb.addWorksheet('Pipeline');
  ws.addRow(['stage', 'deals', 'value', 'won', 'metric', 'python']);
  const rows: Array<[string, number, number, boolean]> = [['lead', 40, 120000, false], ['qualified', 22, 310000, false], ['proposal', 9, 270000, false], ['closed', 4, 180000, true]];
  for (const r of rows) ws.addRow(r);
  ws.getCell('E2').value = { formula: 'SUM(C2:C5)', result: 880000 };
  ws.getCell('E3').value = { formula: 'C5/C2', result: 1.5 };
  ws.getCell('E4').value = { formula: 'XLOOKUP("closed",A2:A5,C2:C5)', result: 180000 }; // outside the 30 functions: #NAME?
  ws.getCell('F2').value = { formula: 'PY("2 + 2")', result: 4 }; // Python inside an imported file: blocked until trusted
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const waitNumber = rawNumber;

async function exorcise(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
  return Date.now() - t0;
}

test.beforeEach(async ({ page }) => {
  await trackLongTasks(page);
});

test('Journey 1 — Flagship 1: Exorcise Model → counterexample → Apply → crimson X-Ray fracture → replay link reproduces in a fresh page', async ({ page, context }) => {
  const errors = watchConsole(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await expect(page).toHaveTitle('SaaS Cash Runway & Unit Economics — Suture X-Ray Studio');
  await expectLanding(page, 'Model!B5');
  await expect(page.getByTestId('inspector-source')).toHaveText('=Inputs!B2/B4');
  await page.getByTestId('sheet-tab-Model').click();
  const runway = await waitNumber(page, 'Model!B5');
  expect(runway).toBeGreaterThan(0);
  await expect(page.getByTestId('cell-Model!B4')).toContainText('PY');
  await expect(page.getByTestId('cell-Model!B5')).toContainText('FX');

  // X-Ray render + scroll inside the 50 ms frame budget.
  await withinFrameBudget(page, 'Flagship 1 X-Ray toggle + scroll', async () => {
    await page.getByTestId('xray-toggle').click();
    await expect(page.locator('[data-testid="xray-thread"]').first()).toBeAttached();
    for (let i = 0; i < 6; i++) { await page.mouse.move(500, 400); await page.mouse.wheel(0, 240); }
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -240);
  });
  expect(await page.locator('[data-testid="xray-thread"][data-engine="formula"]').count()).toBeGreaterThan(0);
  // Req 5.8: scrolling inside the rendered window moves the overlay without recomputing the frame.
  const frameId = await page.getByTestId('xray-overlay').getAttribute('data-frame-id');
  await page.getByTestId('grid').evaluate((el) => { el.scrollTop = 0; el.scrollTop = 30; });
  await page.waitForTimeout(150);
  await expect(page.getByTestId('xray-overlay')).toHaveAttribute('data-frame-id', frameId ?? '');
  await page.getByTestId('grid').evaluate((el) => { el.scrollTop = 0; });
  // Color is never the only signal (steering §2): Formula solid, Python dotted (the B4 stub from Cohorts), arrowheads on every thread.
  expect(await page.locator('[data-testid="xray-thread"][data-engine="formula"][stroke-dasharray]').count()).toBe(0);
  await expect(page.locator('[data-testid="xray-stub"] path[stroke-dasharray="2 4"]').first()).toBeAttached();
  expect(await page.locator('[data-testid="xray-thread"]:not([marker-end])').count()).toBe(0);
  await expect(page.getByTestId('portal-Inputs-in')).toBeVisible();

  const ms = await exorcise(page);
  const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
  const inputs = (await page.getByTestId('failing-inputs').textContent()) ?? '';
  console.log(`[e2e] Journey 1: discovery ${ms} ms — ${violated} — shrunk ${inputs}`);
  expect(violated.startsWith('runway-non-negative:')).toBe(true);
  await expect(page.getByTestId('verdict-mode')).toHaveAttribute('data-mode', 'batched');
  await expect(page.getByTestId('t2-runway-non-negative')).toHaveAttribute('data-status', 'violated');
  for (const id of ['T1.noUnhandledException', 'T1.noNonFiniteLeak', 'T1.strictErrorPropagation', 'T1.editOrderDeterminism', 'T1.crossEngineTolerance']) {
    await expect(page.getByTestId(`t1-${id}`)).toHaveAttribute('data-status', 'held');
  }
  // Auto-focus: X-Ray on, crimson lineage strip, fracture paths, callouts computed without mutating the workbook.
  await expect(page.getByTestId('xray-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');
  await expect(page.getByTestId('callout-Model!B5')).toContainText('runway-non-negative');
  expect(Number(await value(page, 'Model!B5').getAttribute('data-raw'))).toBe(runway);

  await page.getByTestId('apply-counterexample').click();
  await expect(value(page, 'Model!B5')).toHaveText(/^-|#DIV\/0!/, { timeout: 60_000 });
  expect(await page.locator('[data-testid="xray-fracture"]').count()).toBeGreaterThan(0);
  await page.getByTestId('reset-base').click();
  await expect(value(page, 'Model!B5')).toHaveAttribute('data-raw', String(runway), { timeout: 60_000 });

  // The fracture pulses (opacity only); under prefers-reduced-motion it is a static crimson highlight.
  const fracture = page.locator('[data-testid="xray-fracture"]').first();
  expect(await fracture.evaluate((el) => getComputedStyle(el).animationName)).toBe('suture-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await fracture.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Clicking (or Enter on) a fractured thread opens the counterexample.
  await page.getByTestId('panel-tab-cell').click();
  await page.locator('[data-testid="xray-fracture"][role="button"], [data-testid="xray-broken"]').first().press('Enter');
  await expect(page.getByTestId('verdict')).toBeVisible();

  await page.getByTestId('copy-replay').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Replay link copied' })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  const href = (await page.getByTestId('replay-link').getAttribute('href')) ?? '';
  expect(url.endsWith(href)).toBe(true);
  expect(href.startsWith('#replay=v1.')).toBe(true);

  const fresh = await context.newPage();
  const freshErrors = watchConsole(fresh);
  await fresh.goto(url);
  await expect(fresh.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 300_000 });
  await expect(fresh.getByTestId('failing-inputs')).toHaveText(inputs);
  await expect(fresh.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');
  expect(await fresh.locator('[data-testid="xray-fracture"]').count()).toBeGreaterThan(0);
  expect(errors, errors.join('\n')).toEqual([]);
  expect(freshErrors, freshErrors.join('\n')).toEqual([]);
});

test('Journey 2 — Flagship 2: 100k rows aggregate → sheets + Orders drawer → stacked-discount flaw in X-Ray across sheets', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  await page.getByTestId('workbook-picker').selectOption('ecommerce');
  await expect(page).toHaveTitle('100,000-Row E-Commerce Margin Audit — Suture X-Ray Studio');
  await expectLanding(page, 'Margins!B5');
  await page.getByTestId('sheet-tab-Margins').click();
  const margin = await waitNumber(page, 'Margins!B5');
  expect(margin).toBeGreaterThan(0);

  await page.getByTestId('sheet-tab-Orders').click();
  await expect(value(page, 'Orders!A1')).toHaveText('100,000 × 10');
  await page.getByTestId('inspect-Orders!A1').click();
  await expect(page.getByTestId('table-drawer')).toBeVisible();
  await expect(page.getByTestId('drawer-decoded')).toHaveAttribute('data-decoded', '100');
  await expect(page.getByTestId('drawer-row')).toHaveCount(100);
  await page.getByTestId('drawer-close').click();
  await page.getByTestId('sheet-tab-Segments').click();
  await expect(value(page, 'Segments!A1')).toHaveText('96 × 8');

  await page.getByTestId('sheet-tab-Margins').click();
  await withinFrameBudget(page, 'Flagship 2 X-Ray (Alt+X) on Margins', async () => {
    await page.keyboard.press('Alt+KeyX');
    await expect(page.locator('[data-testid="xray-thread"]').first()).toBeAttached();
  });
  await expect(page.getByTestId('portal-Cohorts-in')).toBeVisible();

  // An edit while the session runs marks its verdict stale (Req 7.5). Params!B5 (shipping) is not a fuzz input.
  const t0 = Date.now();
  await page.getByTestId('run-exorcist').click();
  await setCell(page, 'Params!B5', '3.6');
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 300_000 });
  const ms = Date.now() - t0;
  await expect(page.getByTestId('verdict-stale')).toBeVisible();
  const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
  console.log(`[e2e] Journey 2: discovery ${ms} ms — ${violated} — shrunk ${await page.getByTestId('failing-inputs').textContent()}`);
  expect(violated.startsWith('hardlines-stacked-net-margin:')).toBe(true);
  await expect(page.getByTestId('grid')).toHaveAttribute('data-sheet', 'Margins');
  await expect(page.getByTestId('lineage-step-Segments!A3')).toBeVisible();
  await expect(page.getByTestId('lineage-step-Model!B2')).toBeVisible();
  await expect(page.getByTestId('portal-Cohorts-in')).toHaveAttribute('data-fractured', 'true');
  expect(await page.locator('[data-testid="xray-fracture"]').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('callout-Margins!B5')).toContainText('hardlines-stacked-net-margin');

  // Clicking a step in the fracture strip jumps to its sheet and selects the cell.
  await page.getByTestId('lineage-step-Segments!A3').click();
  await expect(page.getByTestId('grid')).toHaveAttribute('data-sheet', 'Segments');
  await expect(page.getByTestId('name-box')).toHaveValue('Segments!A3');
  await expect(page.getByTestId('callout-Segments!A3')).toContainText('SQL → table');
  await expect(page.locator('[data-testid="xray-thread"][data-engine="sql"][stroke-dasharray="6 4"]').first()).toBeAttached();
  await page.getByTestId('portal-Params-in').click();
  await expect(page.getByTestId('grid')).toHaveAttribute('data-sheet', 'Params');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Journey 3 — Blank workbook: honest Lazy → Loading → Ready, drop a real .csv, query it live with =SQL() and =PY(), keyboard grid, 1,048,576 rows', async ({ page }) => {
  const errors = watchConsole(page);
  const seen: Record<string, string[]> = { 'pill-duckdb': [], 'pill-pyodide': [] };
  const track = async (): Promise<void> => {
    for (const id of Object.keys(seen)) {
      const s = (await page.getByTestId(id).getAttribute('data-state')) ?? '';
      const list = seen[id] ?? [];
      if (list[list.length - 1] !== s) list.push(s);
    }
  };
  const t0 = Date.now();
  await openApp(page, '/?workbook=blank');
  const gridMs = Date.now() - t0;
  await expect(page.getByTestId('pill-duckdb')).toHaveText('DuckDB: Lazy');
  await expect(page.getByTestId('pill-pyodide')).toHaveText('Python/NumPy: Lazy');
  await track();
  expect(await telemetry(page, 'tm-coi')).toBe('true');

  // Drag-and-drop a real CSV onto the window.
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'Q3 Orders.csv', { type: 'text/csv' }));
    (globalThis as unknown as { __dt: DataTransfer }).__dt = dt;
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, csvFixture().toString('base64'));
  await expect(page.getByTestId('drop-overlay')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { dataTransfer: (globalThis as unknown as { __dt: DataTransfer }).__dt, bubbles: true, cancelable: true })));
  await expect(page.getByTestId('drop-overlay')).toBeHidden();
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !(seen['pill-duckdb'] ?? []).includes('ready')) { await track(); await page.waitForTimeout(50); }
  await expect(page.getByTestId('toast').filter({ hasText: 'dataset "q3_orders": 2,000 rows × 4 columns' })).toBeVisible();
  await expect(page.getByTestId('drawer-decoded')).toHaveAttribute('data-decoded', '100');
  await expect(page.getByTestId('datasets-toggle')).toHaveText('Datasets (1)');

  // Typing starts editing; Enter commits and moves down. A bare "x" typed in the grid never toggles X-Ray.
  await selectCell(page, 'Sheet1!B1');
  await withinFrameBudget(page, 'typing in the grid', async () => {
    await page.keyboard.press('4');
    await expect(page.getByTestId('cell-editor')).toBeVisible();
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
  });
  await expect(value(page, 'Sheet1!B1')).toHaveText('42');
  await expect(page.getByTestId('name-box')).toHaveValue('Sheet1!B2');
  await page.keyboard.press('x');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('xray-toggle')).toHaveAttribute('aria-pressed', 'false');

  await setCell(page, 'Sheet1!A1', '=SQL("SELECT sum(units * price) * {{B1}} FROM q3_orders WHERE region = \'EU\'")');
  const a1 = await waitNumber(page, 'Sheet1!A1');
  await setCell(page, 'Sheet1!A2', '=SQL("SELECT * FROM q3_orders")');
  await expect(value(page, 'Sheet1!A2')).toHaveText('2,000 × 4', { timeout: 60_000 });
  await setCell(page, 'Sheet1!A3', '=PY("t = inputs[\'A2\']; float(t[\'price\'].mean())")');
  const pyDeadline = Date.now() + 240_000;
  while (Date.now() < pyDeadline && !(seen['pill-pyodide'] ?? []).includes('ready')) { await track(); await page.waitForTimeout(50); }
  const mean = await waitNumber(page, 'Sheet1!A3');
  expect(mean).toBeGreaterThan(0);
  console.log(`[e2e] Journey 3: grid ready after ${gridMs} ms; DuckDB ${seen['pill-duckdb']?.join(' → ')}; Pyodide ${seen['pill-pyodide']?.join(' → ')}`);
  for (const list of Object.values(seen)) {
    expect(list[0]).toBe('notLoaded');
    expect(list).toContain('ready');
    expect(list.slice(list.indexOf('loading') + 1)).not.toContain('notLoaded');
  }

  // A warm edit: B1 → A1 recomputes in DuckDB with no engine boot.
  await selectCell(page, 'Sheet1!B1');
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(value(page, 'Sheet1!A1')).not.toHaveAttribute('data-raw', String(a1), { timeout: 60_000 });
  expect(Number(await value(page, 'Sheet1!A1').getAttribute('data-raw'))).toBeCloseTo((a1 / 42) * 2, 4);
  const warm = await telemetry(page, 'tm-warm-eval-ms');
  expect(warm).toMatch(/\d+ ms/);
  console.log(`[e2e] Journey 3: cold boot DuckDB ${await telemetry(page, 'tm-duckdb-ms')}, Pyodide ${await telemetry(page, 'tm-pyodide-ms')}; first eval ${await telemetry(page, 'tm-first-eval-ms')}; warm DAG eval ${warm}; validator ${await telemetry(page, 'tm-validator')}`);

  // Formula bar (Req 2.3, 2.4): an =PY( draft expands; Shift+Enter inserts a newline; Escape discards the draft.
  await selectCell(page, 'Sheet1!D1');
  const bar = page.getByTestId('formula-input');
  await bar.fill('=PY("1 + 1")');
  await bar.press('Shift+Enter');
  expect(await bar.inputValue()).toContain('\n');
  expect(Number(await bar.getAttribute('rows'))).toBeGreaterThanOrEqual(3);
  await bar.press('Escape');
  await expect(value(page, 'Sheet1!D1')).toHaveCount(0);
  await expect(bar).toHaveValue('');

  // Keyboard navigation (Req 1.3).
  await selectCell(page, 'Sheet1!A1');
  const nb = page.getByTestId('name-box');
  await page.keyboard.press('ArrowRight'); await expect(nb).toHaveValue('Sheet1!B1');
  await page.keyboard.press('ArrowDown'); await expect(nb).toHaveValue('Sheet1!B2');
  await page.keyboard.press('Tab'); await expect(nb).toHaveValue('Sheet1!C2');
  await page.keyboard.press('Shift+Tab'); await expect(nb).toHaveValue('Sheet1!B2');
  await page.keyboard.press('Enter'); await expect(nb).toHaveValue('Sheet1!B3');
  await page.keyboard.press('Shift+Enter'); await expect(nb).toHaveValue('Sheet1!B2');
  await page.keyboard.press('ArrowLeft'); await expect(nb).toHaveValue('Sheet1!A2');
  await page.keyboard.press('PageDown');
  // Poll: the selection lands after the page height is measured, and a one-shot read could see the old row.
  await expect.poll(async () => Number(((await nb.inputValue()).match(/\d+$/) ?? ['0'])[0])).toBeGreaterThan(10);
  await page.keyboard.press('Control+Home'); await expect(nb).toHaveValue('Sheet1!A1');
  await selectCell(page, 'Sheet1!C5');
  await page.keyboard.press('z'); await page.keyboard.press('Enter');
  await expect(value(page, 'Sheet1!C5')).toHaveText('z');
  await selectCell(page, 'Sheet1!C5');
  await page.keyboard.press('Delete');
  await expect(value(page, 'Sheet1!C5')).toHaveCount(0);
  await expect(page.getByTestId('grid')).toHaveAttribute('aria-rowcount', '1048576');

  // Fling through the full 1,048,576-row sheet inside the frame budget.
  await withinFrameBudget(page, 'scroll fling + jump to row 1,048,576', async () => {
    await page.mouse.move(500, 400);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 4000);
    await page.keyboard.press('Control+End');
    await expect(page.getByTestId('last-row-header')).toHaveText('1048576');
  });

  // Exorcise on a workbook with no fuzz domain explains what is missing instead of running.
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('exorcist-status')).toContainText('Add at least one fuzz domain');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Journey 4 — real .xlsx with formulas: evaluate, trust gate for imported Python, custom Tier 2 assertion, Exorcist', async ({ page }) => {
  const errors = watchConsole(page);
  const scripts: string[] = [];
  const pyodideBytes: string[] = [];
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.js')) scripts.push(r.url());
    if (/pyodide\.asm\.wasm/.test(r.url())) pyodideBytes.push(r.url());
    if (r.method() !== 'GET') uploads.push(`${r.method()} ${r.url()}`);
  });
  await openApp(page, '/?workbook=blank');
  await page.getByTestId('import-file').setInputFiles({ name: 'Pipeline.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsxFixture() });
  await expect(page.getByTestId('toast').filter({ hasText: 'sheets "Pipeline"' })).toBeVisible({ timeout: 120_000 });
  expect(scripts.some((u) => /ingest\.worker/.test(u)), 'the ingest worker chunk loads lazily on the first .xlsx import').toBe(true);
  await expect(page.getByTestId('grid')).toHaveAttribute('data-sheet', 'Pipeline');
  await expect(value(page, 'Pipeline!E2')).toHaveText('880,000', { timeout: 60_000 });
  await expect(value(page, 'Pipeline!E3')).toHaveText('1.5');
  await expect(value(page, 'Pipeline!E4')).toHaveText('#NAME?');
  await expect(page.getByTestId('cell-Pipeline!E4')).toHaveAttribute('title', /#NAME\?/);
  // Inspector (Req 3.2): error code, message, engine, and an origin link that selects the origin cell.
  await selectCell(page, 'Pipeline!E3');
  await selectCell(page, 'Pipeline!E4');
  await expect(page.getByTestId('inspector-error')).toContainText('#NAME?');
  await page.getByTestId('error-origin').click();
  await expect(page.getByTestId('name-box')).toHaveValue('Pipeline!E4');

  // Imported Python is blocked (#PY!, no Pyodide download) until the user trusts the workbook.
  await expect(page.getByTestId('trust-banner')).toContainText('1 Python cell');
  await expect(value(page, 'Pipeline!F2')).toHaveText('#PY!');
  await expect(page.getByTestId('cell-Pipeline!F2')).toHaveAttribute('title', /Python is blocked until you trust this workbook/);
  await expect(page.getByTestId('pill-pyodide')).toHaveAttribute('data-state', 'notLoaded');
  expect(pyodideBytes).toEqual([]);
  await expect(page.getByTestId('run-exorcist')).toBeDisabled();
  await page.getByTestId('trust-python').click();
  await expect(page.getByTestId('trust-banner')).toBeHidden();
  await expect(value(page, 'Pipeline!F2')).toHaveText('4', { timeout: 240_000 });

  // Custom fuzz domain on C5 and a custom Tier 2 assertion on E3 (= C5 / C2).
  await selectCell(page, 'Pipeline!C5');
  await page.getByTestId('panel-tab-assertions').click();
  await page.getByTestId('add-domain').click();
  await expect(page.getByTestId('domain-row-0')).toContainText('Pipeline!C5');
  await selectCell(page, 'Pipeline!E3');
  await page.getByTestId('add-assertion').click();
  await page.getByTestId('assertion-kind-0').selectOption('lte');
  await page.getByTestId('assertion-operand-0').fill('2');
  await page.getByTestId('assertion-operand-0').press('Enter');
  await page.getByTestId('assertion-id-0').fill('conversion-at-most-2');
  await page.getByTestId('assertion-id-0').press('Enter');
  await expect(page.getByTestId('assert-conversion-at-most-2')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('config-check')).toContainText('In-Process fast-check');

  const ms = await exorcise(page);
  const violated = (await page.getByTestId('violated-assertion').textContent()) ?? '';
  console.log(`[e2e] Journey 4: discovery ${ms} ms — ${violated} — shrunk ${await page.getByTestId('failing-inputs').textContent()}`);
  expect(violated.startsWith('conversion-at-most-2:')).toBe(true);
  await expect(page.getByTestId('verdict-mode')).toHaveAttribute('data-mode', 'inProcess');
  // Replay files for a workbook that is not built in (Req 7.3): download the replay and the workbook, then in a fresh
  // page import the replay (it asks for the document) and the .suture.json (it replays exactly).
  const replayDl = page.waitForEvent('download');
  await page.getByTestId('download-replay').click();
  const replayPath = await (await replayDl).path();
  const docDl = page.waitForEvent('download');
  await page.getByTestId('export-workbook').click();
  const doc = await docDl;
  const docPath = await doc.path();
  expect(doc.suggestedFilename()).toBe('blank-workbook.suture.json');

  await page.getByTestId('apply-counterexample').click();
  await page.getByTestId('panel-tab-assertions').click();
  await expect(page.getByTestId('assert-conversion-at-most-2')).toHaveAttribute('data-ok', 'false');
  expect(uploads, 'imports never upload bytes').toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);

  const fresh = await page.context().newPage();
  const freshErrors = watchConsole(fresh);
  await openApp(fresh);
  await fresh.getByTestId('import-file').setInputFiles({ name: 'suture-replay.json', mimeType: 'application/json', buffer: readFileSync(replayPath) });
  await expect(fresh.getByTestId('replay-prompt')).toBeVisible();
  await fresh.getByTestId('import-file').setInputFiles({ name: 'blank-workbook.suture.json', mimeType: 'application/json', buffer: readFileSync(docPath) });
  // Its =PY() cell is untrusted again in a new session, and the replay (which would run it) waits for trust.
  await expect(fresh.getByTestId('trust-banner')).toBeVisible();
  await expect(fresh.getByTestId('replay-prompt')).toBeHidden();
  await expect(fresh.getByTestId('exorcist-status')).toContainText('Trust this workbook');
  await fresh.getByTestId('trust-python').click();
  await expect(fresh.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 240_000 });
  expect(freshErrors, freshErrors.join('\n')).toEqual([]);
});

/**
 * Spec 04 task 1.2 / Req 1.5 with Spec 01 §7.3: the incremental graph and the sliced recalculation preamble keep every task
 * of a 20,000-formula recalculation under the unchanged 50 ms limit. The name box also resolves a defined name (task 3.1).
 */
test('Req 1.5 — editing the input of 20,000 formulas recalculates without a main-thread task over 50 ms', async ({ page }) => {
  const errors = watchConsole(page);
  const cells = [{ key: 'Load!A1', raw: '1' }, ...Array.from({ length: 20_000 }, (_, i) => ({ key: `Load!B${i + 2}`, raw: `=$A$1*${i + 2}` }))];
  const doc = {
    format: 'suture.workbook', version: 1, title: '20,000 formulas',
    workbook: { sheets: [{ name: 'Load', cells }], names: [{ name: 'Driver', target: { kind: 'cell', coord: { sheet: 'Load', row: 0, col: 0 } } }], datasets: [], seed: 1 },
    exorcist: { numRuns: 1000, batchSize: 200, maxBatches: 10, maxShrinkRounds: 64, inputs: [], assertions: [] },
  };
  await openApp(page, '/?workbook=blank');
  await page.getByTestId('import-file').setInputFiles({ name: 'load.suture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(value(page, 'Load!B21')).toHaveText('21', { timeout: 120_000 });
  const before = await telemetry(page, 'tm-warm-eval-ms');
  // Spec 04 Req 2.2 / task 3.1: a defined name in the name box selects its target cell.
  await selectCell(page, 'Load!B9');
  await page.getByTestId('name-box').fill('driver');
  await page.getByTestId('name-box').press('Enter');
  await expect(page.getByTestId('name-box')).toHaveValue('Load!A1');
  await expect(page.getByTestId('cell-Load!A1')).toHaveAttribute('aria-selected', 'true');
  await withinFrameBudget(page, 'edit A1 → 20,000 dependent formulas', async () => {
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    await expect(value(page, 'Load!B21')).toHaveText('105', { timeout: 60_000 });
    await expect.poll(async () => telemetry(page, 'tm-warm-eval-ms'), { timeout: 60_000 }).not.toBe(before);
  });
  console.log(`[e2e] 20,000-formula recalculation: warm DAG eval ${await telemetry(page, 'tm-warm-eval-ms')}`);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Journey 5 — 390×844: no horizontal overflow, Exorcise stays reachable, zero third-party spreadsheet trademarks in the DOM', async ({ page }) => {
  const errors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.getByTestId('narrow-banner')).toBeVisible();
  await expect(page.getByTestId('run-exorcist')).toBeInViewport();
  for (const id of ['saas', 'ecommerce', 'blank'] as const) {
    if (id !== 'saas') await page.getByTestId('workbook-picker').selectOption(id);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
    expect(overflow, `${id}: horizontal page overflow`).toEqual({ doc: 0, body: 0 });
    expect(await scanDomForTrademarks(page), `${id}: banned product name in the DOM`).toEqual([]);
  }
  await page.getByTestId('workbook-picker').selectOption('saas');
  await page.getByTestId('run-exorcist').click();
  await expect(page.getByTestId('stop-exorcist')).toBeVisible();
  await page.getByTestId('stop-exorcist').click();
  await expect(page.getByTestId('run-exorcist')).toBeVisible();
  await page.getByTestId('panel-tab-audit').click();
  await expect(page.getByTestId('exorcist-status')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);

  // A corrupted replay link shows its decode error instead of replaying (Req 7.3).
  const broken = await page.context().newPage();
  const brokenErrors = watchConsole(broken);
  await openApp(broken, '/#replay=v1.not-a-real-artifact');
  await expect(broken.getByTestId('exorcist-status')).toHaveText(/^replay link: /);
  expect(brokenErrors, brokenErrors.join('\n')).toEqual([]);

  // Loading shell (Req 11.6): with the app bundle held back, the HTML alone paints the obsidian shell (never a white
  // frame); once the bundle runs, React replaces it with the app.
  const slow = await page.context().newPage();
  const slowErrors = watchConsole(slow);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await slow.route(/\/assets\/index-[^/]*\.js$/, async (route) => { await held; await route.continue(); });
  await slow.goto('/', { waitUntil: 'commit' });
  const shell = slow.getByTestId('loading-shell');
  await expect(shell).toBeVisible();
  await expect(shell).toContainText('SUTURE');
  await expect(shell).toContainText('Initializing local engines…');
  await expect(shell).toHaveAttribute('role', 'status');
  expect(await slow.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.getElementById('suture-shell') as HTMLElement).backgroundColor])).toEqual(['rgb(9, 11, 16)', 'rgb(9, 11, 16)']);
  release();
  await expect(slow.getByTestId('pill-grid')).toHaveText('Grid: Ready');
  await expect(shell).toHaveCount(0);
  expect(slowErrors, slowErrors.join('\n')).toEqual([]);
});

/**
 * Spec 04 Req 4.1 / 4.4, task 4.1: the app page served WITHOUT COOP/COEP (the e2e build's unisolated origin) shows the
 * honest degraded label for each engine once it loads (Python stays Lazy until the first =PY()), the full reason in the
 * pill's accessible name, and the crossOriginIsolated-based note in the popover, while both engines still evaluate.
 */
test('Req 4.1 — unisolated app page: Lazy → Degraded (restart on timeout) for DuckDB and Python, plain-words reason, both engines still evaluate', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`${HARNESS_NO_ISOLATION_ORIGIN}/?workbook=blank`);
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid: Ready');
  await expect(page.getByTestId('pill-duckdb')).toHaveText('DuckDB: Lazy');
  await expect(page.getByTestId('pill-pyodide')).toHaveText('Python/NumPy: Lazy');
  await setCell(page, 'Sheet1!A1', '=SQL("SELECT 6 * 7 AS answer")');
  await expect(value(page, 'Sheet1!A1')).toHaveText('42', { timeout: 120_000 });
  await expect(page.getByTestId('pill-duckdb')).toHaveAttribute('data-state', 'degraded');
  await expect(page.getByTestId('pill-duckdb')).toHaveText('DuckDB: Degraded (restart on timeout)');
  await expect(page.getByTestId('pill-pyodide')).toHaveText('Python/NumPy: Lazy');
  await setCell(page, 'Sheet1!A2', '=PY("6 * 7")');
  await expect(value(page, 'Sheet1!A2')).toHaveText('42', { timeout: 120_000 });
  await expect(page.getByTestId('pill-pyodide')).toHaveAttribute('data-state', 'degraded');
  await expect(page.getByTestId('pill-pyodide')).toHaveText('Python/NumPy: Degraded (restart on timeout)');
  await expect(page.getByTestId('readiness-pill')).toHaveAttribute('aria-label', /DuckDB: Degraded \(restart on timeout\)\. DuckDB: timeouts restart the engine \(page is not cross-origin isolated\)/);
  await expect(page.getByTestId('readiness-pill')).toHaveAttribute('aria-label', /Python\/NumPy: Degraded \(restart on timeout\)\. Python\/NumPy: timeouts restart the engine \(page is not cross-origin isolated\)/);
  await page.getByTestId('readiness-pill').click();
  await expect(page.getByTestId('tm-coi')).toHaveText('false');
  await expect(page.getByTestId('tm-degraded-note')).toContainText('not cross-origin isolated');
  await expect(page.getByTestId('telemetry-popover')).toContainText('DuckDB: timeouts restart the engine (page is not cross-origin isolated)');
  await page.keyboard.press('Escape');
  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * Spec 04 Req 7.6: a Suture X-Ray link produced by the Suture Crew app (real fixture, not generated here) opens straight
 * onto the built-in Crew sample and reproduces exactly, with no import prompt, the crimson fracture on, and the
 * violated cell selected on its sheet.
 */
test('Req 7.6 — a Suture Crew X-Ray link opens on the built-in sample and reproduces exactly, no import', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page, `/#${CREW_REPLAY_FRAGMENT}`);
  await expect(page.getByTestId('exorcist-status')).toHaveText('replay: reproduced (exact)', { timeout: 300_000 });
  await expect(page).toHaveTitle('Wholesale Quote Margin (Suture Crew sample) — Suture X-Ray Studio');
  await expect(page.getByTestId('workbook-picker')).toHaveValue('wholesale');
  await expect(page.getByTestId('replay-prompt')).toHaveCount(0);
  await expect(page.getByTestId('violated-assertion')).toContainText(CREW_VIOLATED_ASSERTION);
  await expect(page.getByTestId('xray-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lineage')).toHaveAttribute('data-failing', 'true');
  await expect(page.getByTestId('grid')).toHaveAttribute('data-sheet', 'Quote');
  // The failing edge crosses sheets (Pricing!A1 SQL -> Quote!B2), so the fracture shows as a crimson portal badge.
  await expect(page.getByTestId('portal-Pricing-in')).toHaveAttribute('data-fractured', 'true');
  await page.screenshot({ path: test.info().outputPath('crew-link.png') });
  expect(errors, errors.join('\n')).toEqual([]);
});
