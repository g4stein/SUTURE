import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Workbook } from 'exceljs';
import { watchConsole } from './console.ts';
import { csvFixture, openApp, setCell, showDatasets, value } from './app.ts';

/** exceljs's browser build (the same one the ingest worker bundles) generates a real .xlsx fixture in Node. */
const require = createRequire(import.meta.url);
const { Workbook: XlsxWorkbook } = require('exceljs/dist/exceljs.min.js') as { Workbook: new () => Workbook };

async function xlsxFixture(): Promise<Buffer> {
  const wb = new XlsxWorkbook();
  const ws = wb.addWorksheet('Pipeline');
  ws.addRow(['stage', 'deals', 'value', 'won', 'metric']);
  const rows: Array<[string, number, number, boolean]> = [['lead', 40, 120000, false], ['qualified', 22, 310000, false], ['proposal', 9, 270000, false], ['closed', 4, 180000, true]];
  for (const r of rows) ws.addRow(r);
  ws.getCell('E2').value = { formula: 'SUM(C2:C5)', result: 880000 };
  ws.getCell('E3').value = { formula: 'C5/C2', result: 1.5 };
  ws.getCell('E4').value = { formula: 'XLOOKUP("closed",A2:A5,C2:C5)', result: 180000 }; // outside the 30: #NAME? in Suture
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('BYO data: .csv and .xlsx import locally, exceljs loads only on the first .xlsx import, =SQL() runs against both', async ({ page }) => {
  const errors = watchConsole(page);
  const scripts: string[] = [];
  page.on('request', (r) => { if (r.resourceType() === 'script' || r.url().endsWith('.js')) scripts.push(r.url()); });
  const uploads: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') uploads.push(`${r.method()} ${r.url()}`); });
  await openApp(page, '/?workbook=blank');

  // .csv → DuckDB registerFileBuffer + read_csv_auto
  await page.getByTestId('import-file').setInputFiles({ name: 'Q3 Orders.csv', mimeType: 'text/csv', buffer: csvFixture() });
  await expect(page.getByTestId('datasets-toggle')).toHaveText('Datasets (1)', { timeout: 120_000 });
  await showDatasets(page);
  await expect(page.getByTestId('import-report').first()).toHaveAttribute('data-ok', 'true', { timeout: 120_000 });
  await expect(page.getByTestId('dataset-q3_orders')).toContainText('2,000 rows');
  await expect(page.getByTestId('dataset-q3_orders')).toContainText('units:Int64');
  expect(scripts.some((u) => /ingest\.worker/.test(u)), 'the ingest worker is not loaded for CSV').toBe(false);
  await setCell(page, 'Sheet1!A1', '=SQL("SELECT sum(units * price) FROM q3_orders WHERE region = \'EU\'")');
  await expect(value(page, 'Sheet1!A1')).toHaveAttribute('data-raw', /^\d+(\.\d+)?$/, { timeout: 60_000 });

  // .xlsx → ingest worker (exceljs) → sheets + Arrow table → DuckDB
  await page.getByTestId('import-file').setInputFiles({ name: 'Pipeline.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsxFixture() });
  await expect(page.getByTestId('datasets-toggle')).toHaveText('Datasets (2)', { timeout: 120_000 });
  await expect(page.getByTestId('toast').filter({ hasText: 'sheets "Pipeline"' })).toBeVisible({ timeout: 120_000 });
  await showDatasets(page);
  await expect(page.getByTestId('import-report').first()).toContainText('sheets "Pipeline"');
  await expect(page.getByTestId('import-report').first()).toContainText('1 cell(s) #NAME?');
  expect(scripts.some((u) => /ingest\.worker/.test(u)), 'the ingest worker chunk loads lazily on the first .xlsx import').toBe(true);
  await expect(value(page, 'Pipeline!E2')).toHaveText('880,000');
  await expect(value(page, 'Pipeline!E3')).toHaveText('1.5');
  await expect(value(page, 'Pipeline!E4')).toHaveText('#NAME?');
  await expect(page.getByTestId('dataset-pipeline_xlsx_pipeline')).toContainText('4 rows');
  await setCell(page, 'Sheet1!A2', '=SQL("SELECT sum(deals) FROM pipeline_xlsx_pipeline WHERE NOT won")');
  await expect(value(page, 'Sheet1!A2')).toHaveText('71', { timeout: 60_000 });
  await setCell(page, 'Sheet1!A4', '=SQL("SELECT * FROM pipeline_xlsx_pipeline")');
  await setCell(page, 'Sheet1!A3', '=PY("t = inputs[\'A4\']; float(t[\'value\'].mean())")'); // one-line source: ';' separates statements
  await expect(value(page, 'Sheet1!A3')).toHaveText('220,000', { timeout: 240_000 });

  expect(uploads, 'imports never upload bytes').toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});
