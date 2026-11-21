import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Workbook } from 'exceljs';
import { watchConsole } from './console.ts';

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

function csvFixture(): Buffer {
  const lines = ['sku,region,units,price', ...Array.from({ length: 2000 }, (_, i) => `SKU-${i % 50},${['NA', 'EU', 'APAC'][i % 3]},${1 + (i % 9)},${(5 + (i * 13) % 200) / 2}`)];
  return Buffer.from(lines.join('\n'));
}

test('BYO data: .csv and .xlsx import locally, exceljs loads only on the first .xlsx import, =SQL() runs against both', async ({ page }) => {
  const errors = watchConsole(page);
  const scripts: string[] = [];
  page.on('request', (r) => { if (r.resourceType() === 'script' || r.url().endsWith('.js')) scripts.push(r.url()); });
  const uploads: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') uploads.push(`${r.method()} ${r.url()}`); });
  await page.goto('/');
  await expect(page.getByTestId('pill-grid')).toHaveText('Grid Ready');

  // .csv → DuckDB registerFileBuffer + read_csv_auto
  await page.getByTestId('import-file').setInputFiles({ name: 'Q3 Orders.csv', mimeType: 'text/csv', buffer: csvFixture() });
  await expect(page.getByTestId('import-report').first()).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('dataset-q3_orders')).toContainText('2,000 rows');
  await expect(page.getByTestId('dataset-q3_orders')).toContainText('units:Int64');
  expect(scripts.some((u) => /ingest\.worker/.test(u)), 'the ingest worker is not loaded for CSV').toBe(false);
  await page.getByTestId('new-cell-key').fill('Data!A1');
  await page.getByTestId('new-cell-raw').fill('=SQL("SELECT sum(units * price) FROM q3_orders WHERE region = \'EU\'")');
  await page.getByTestId('new-cell-add').click();
  await expect(page.getByTestId('value-Data!A1')).toHaveText(/^\d+(\.\d+)?$/);

  // .xlsx → ingest worker (exceljs) → sheets + Arrow table → DuckDB
  await page.getByTestId('import-file').setInputFiles({ name: 'Pipeline.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsxFixture() });
  await expect(page.getByTestId('import-report').first()).toContainText('sheets "Pipeline"');
  await expect(page.getByTestId('import-report').first()).toContainText('1 cell(s) #NAME?');
  expect(scripts.some((u) => /ingest\.worker/.test(u)), 'the ingest worker chunk loads lazily on the first .xlsx import').toBe(true);
  await expect(page.getByTestId('value-Pipeline!E2')).toHaveText('880000');
  await expect(page.getByTestId('value-Pipeline!E3')).toHaveText('1.5');
  await expect(page.getByTestId('value-Pipeline!E4')).toHaveText('#NAME?');
  await expect(page.getByTestId('dataset-pipeline_xlsx_pipeline')).toContainText('4 rows');
  await page.getByTestId('new-cell-key').fill('Data!A2');
  await page.getByTestId('new-cell-raw').fill('=SQL("SELECT sum(deals) FROM pipeline_xlsx_pipeline WHERE NOT won")');
  await page.getByTestId('new-cell-add').click();
  await expect(page.getByTestId('value-Data!A2')).toHaveText('71');
  await page.getByTestId('new-cell-key').fill('Data!A3');
  await page.getByTestId('new-cell-raw').fill('=PY("t = inputs[\'A4\']; float(t[\'value\'].mean())")'); // one-line input: ';' separates statements
  await page.getByTestId('new-cell-add').click();
  await page.getByTestId('new-cell-key').fill('Data!A4');
  await page.getByTestId('new-cell-raw').fill('=SQL("SELECT * FROM pipeline_xlsx_pipeline")');
  await page.getByTestId('new-cell-add').click();
  await expect(page.getByTestId('value-Data!A3')).toHaveText('220000');

  expect(uploads, 'imports never upload bytes').toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});
