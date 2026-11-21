import { createRequire } from 'node:module';
import * as fc from 'fast-check';
import { tableFromIPC } from 'apache-arrow';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Workbook } from 'exceljs';
import {
  createWorkbookEngine, literalDisplay, NEVER_CANCELLED, toCellKey,
  type CellKey, type Edit, type WorkbookDefinition,
} from '@suture/core';
import { nodeEngines, nodeHasher, openNodeDuckDB, type NodeEngines } from '../src/node/index.ts';
import { ingestXlsx, translateSharedFormula, type WorkbookCtor } from '../src/engines/index.ts';
import { sanitizeDatasetName, type RegisterDatasetPayload, type WorkerResult } from '../src/bridge/index.ts';

/** exceljs's browser build (the one ingest.worker.ts bundles) also runs in Node; its Node entry needs the removed unzipper. */
const require = createRequire(import.meta.url);
const { Workbook: XlsxWorkbook } = require('exceljs/dist/exceljs.min.js') as { Workbook: WorkbookCtor };

let e: NodeEngines;
beforeAll(async () => { e = await nodeEngines(); });

const OPTS = { priority: 'interactive' as const, deadlineMs: 120_000, signal: null, generation: null };

async function register(name: string, bytes: Uint8Array, sourceFormat: RegisterDatasetPayload['sourceFormat'], encoding: RegisterDatasetPayload['encoding']): Promise<WorkerResult> {
  const hex = [...(await nodeHasher.sha256(bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return e.duckdb.request('duckdb.registerDataset', { name, sourceFormat, encoding, bytes, sha256: hex }, OPTS);
}

async function evaluate(def: WorkbookDefinition, keys: ReadonlyArray<CellKey>): Promise<Map<CellKey, unknown>> {
  const eng = createWorkbookEngine(def, e.deps);
  await eng.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
  return new Map(keys.map((k) => [k, eng.getValue(k)]));
}

const K = (sheet: string, row: number, col: number): CellKey => toCellKey({ sheet, row, col });

describe('BYO data ingest against real DuckDB-WASM (Spec 02 Req 5)', () => {
  it('sanitizes dataset names', () => {
    expect(sanitizeDatasetName('Q3 Sales.csv', [])).toBe('q3_sales');
    expect(sanitizeDatasetName('2024.csv', [])).toBe('_2024');
    expect(sanitizeDatasetName('Q3 Sales.csv', ['q3_sales'])).toBe('q3_sales_2');
  });

  it('.csv: registerFileBuffer + read_csv_auto, schema inference, preview, then =SQL() and =PY() over it', async () => {
    const rows = ['region,month,revenue,churned', ...Array.from({ length: 500 }, (_, i) => `${['NA', 'EU', 'APAC'][i % 3]},${1 + (i % 12)},${(100 + (i * 37) % 900) / 4},${i % 7 === 0}`)];
    const r = await register('sales', new TextEncoder().encode(rows.join('\n')), 'csv', 'csv');
    expect(r.kind).toBe('dataset');
    if (r.kind !== 'dataset') return;
    expect(r.meta).toMatchObject({ name: 'sales', format: 'csv', rowCount: 500 });
    expect(r.meta.schema.map((f) => `${f.name}:${f.arrowType}`)).toEqual(['region:Utf8', 'month:Int64', 'revenue:Float64', 'churned:Bool']);
    expect(r.preview.rowCount).toBe(100);
    const def: WorkbookDefinition = {
      sheets: [{ name: 'S', cells: [
        { key: K('S', 0, 0), raw: '=SQL("SELECT region, sum(revenue) AS revenue FROM sales GROUP BY region ORDER BY region")' },
        { key: K('S', 1, 0), raw: '=SQL("SELECT count(*) FROM sales WHERE churned")' },
        { key: K('S', 2, 0), raw: '=PY("t = inputs[\'A1\']\nfloat(t[\'revenue\'].sum())")' },
        { key: K('S', 3, 0), raw: '=SQL("SELECT sum(revenue) FROM sales")' },
        { key: K('S', 4, 0), raw: '=SQL("SELECT * FROM read_csv(\'x.csv\')")' },
      ] }],
      names: [], datasets: [r.meta], seed: 1,
    };
    const v = await evaluate(def, [K('S', 0, 0), K('S', 1, 0), K('S', 2, 0), K('S', 3, 0), K('S', 4, 0)]);
    expect(v.get(K('S', 0, 0))).toMatchObject({ kind: 'table', rowCount: 3 });
    expect(v.get(K('S', 1, 0))).toBe(rows.slice(1).filter((l) => l.endsWith('true')).length);
    expect(v.get(K('S', 2, 0))).toBeCloseTo(v.get(K('S', 3, 0)) as number, 6);
    expect(v.get(K('S', 4, 0))).toMatchObject({ code: '#SQL!' }); // user SQL still cannot read files directly
  });

  it('.csv: a malformed file is reported with DuckDB\'s message and registers nothing', async () => {
    // Invalid UTF-8 is rejected by the CSV reader (DuckDB's sniffer tolerates ragged rows and a trailing open quote).
    const r = await register('broken', Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x31, 0x0a]), 'csv', 'csv');
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.message).toMatch(/unicode|utf-?8|encoding/i);
    const listed = await e.duckdb.request('duckdb.query', { cell: 'S!A1' as CellKey, sql: 'SELECT 1 FROM broken', params: [], tables: [] }, OPTS);
    expect(listed).toMatchObject({ kind: 'value', value: { code: '#SQL!' } });
  });

  it('.parquet: the extension loads lazily on the first Parquet upload, then ingests', async () => {
    // Generate a real Parquet file with DuckDB itself (a separate connection with autoload on).
    const gen = (await openNodeDuckDB()).conn;
    gen.query("COPY (SELECT i AS id, i * 1.5 AS amount, CASE WHEN i % 2 = 0 THEN 'even' ELSE 'odd' END AS parity FROM range(2500) t(i)) TO 'gen.parquet' (FORMAT parquet)");
    const bytes = gen.useUnsafe((b) => b.copyFileToBuffer('gen.parquet'));
    const t0 = performance.now();
    const r = await register('ledger', bytes, 'parquet', 'parquet');
    console.info(`[ingest] first Parquet upload (incl. lazy INSTALL/LOAD parquet): ${Math.round(performance.now() - t0)} ms`);
    expect(r.kind).toBe('dataset');
    if (r.kind !== 'dataset') return;
    expect(r.meta.rowCount).toBe(2500);
    expect(r.meta.schema.map((f) => f.name)).toEqual(['id', 'amount', 'parity']);
    const t1 = performance.now();
    const again = await register('ledger_2', bytes, 'parquet', 'parquet');
    console.info(`[ingest] second Parquet upload (extension already loaded): ${Math.round(performance.now() - t1)} ms`);
    expect(again.kind).toBe('dataset');
  });

  it('.xlsx: real exceljs-generated workbook → sheets, literals, formulas, Arrow tables → DuckDB → =SQL() / =PY()', async () => {
    const wb: Workbook = new XlsxWorkbook();
    const ws = wb.addWorksheet('Q3 Plan');
    ws.addRow(['region', 'amount', 'active', 'booked']);
    const data: Array<[string, number, boolean]> = [['NA', 120, true], ['EU', 80.5, false], ['APAC', 42, true], ['NA', 7, true]];
    data.forEach(([r, a, act], i) => {
      ws.addRow([r, a, act, new Date(Date.UTC(2026, 0, 1 + i))]);
    });
    const notes = wb.addWorksheet('Notes');
    notes.getCell('B2').value = { formula: "SUM('Q3 Plan'!B2:B5)", result: 249.5 };
    notes.getCell('B3').value = { formula: "XLOOKUP(\"EU\",'Q3 Plan'!A2:A5,'Q3 Plan'!B2:B5)", result: 80.5 }; // outside the 30-function subset
    notes.getCell('B4').value = { formula: "'Q3 Plan'!B2*2", result: 240, ref: 'B4:B5', shareType: 'shared' } as unknown as { formula: string; result: number };
    notes.getCell('B5').value = { sharedFormula: 'B4', result: 161 } as unknown as { formula: string; result: number };
    notes.getCell('C2').value = '00123'; // a string that looks like a number must stay a string (lossless literal)
    notes.getCell('D2').value = { error: '#N/A' } as unknown as string;
    notes.mergeCells('F1:G1');
    notes.getCell('F1').value = 'merged';
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());

    const result = await ingestXlsx(XlsxWorkbook, bytes);
    const [sheetOut, notesOut] = result.sheets;
    expect(result.sheets.map((x) => x.name)).toEqual(['Q3 Plan', 'Notes']);
    const at = (row: number, col: number) => notesOut?.cells.find((c) => c.row === row && c.col === col);
    expect(at(1, 1)).toEqual({ row: 1, col: 1, kind: 'raw', raw: "=SUM('Q3 Plan'!B2:B5)" });
    expect(at(4, 1)).toEqual({ row: 4, col: 1, kind: 'raw', raw: "='Q3 Plan'!B3*2" }); // shared formula translated from master B4
    expect(at(1, 2)).toEqual({ row: 1, col: 2, kind: 'literal', value: '00123' });
    expect(at(1, 3)).toEqual({ row: 1, col: 3, kind: 'raw', raw: '#N/A' });
    expect(sheetOut?.cells.find((c) => c.row === 1 && c.col === 3)).toEqual({ row: 1, col: 3, kind: 'literal', value: 46023 }); // 2026-01-01 as a serial date
    expect(result.warnings.join(' ')).toMatch(/merged/);
    const table = result.tables[0];
    expect(table).toMatchObject({ sheet: 'Q3 Plan', header: 'firstRow', rowCount: 4 });
    expect(tableFromIPC(table?.ipc ?? new Uint8Array()).schema.fields.map((f) => `${f.name}:${String(f.type)}`).slice(0, 4)).toEqual(['region:Utf8', 'amount:Float64', 'active:Bool', 'booked:Float64']);

    const name = sanitizeDatasetName(`plan.xlsx_${table?.sheet ?? ''}`, []);
    const reg = await register(name, table?.ipc ?? new Uint8Array(), 'xlsx', 'arrow');
    expect(reg.kind).toBe('dataset');
    if (reg.kind !== 'dataset') return;

    // Build a Suture sheet from the imported cells (lossless setLiteral for values) and query the dataset next to it.
    const S = 'Q3 Plan';
    const N = 'Notes';
    const eng = createWorkbookEngine({ sheets: [{ name: S, cells: [] }, { name: N, cells: [] }, { name: 'Q', cells: [] }], names: [], datasets: [reg.meta], seed: 1 }, e.deps);
    const edits: Edit[] = result.sheets.flatMap((sh) => sh.cells.map((c): Edit => (c.kind === 'raw' ? { kind: 'setCell', key: K(sh.name, c.row, c.col), raw: c.raw } : { kind: 'setLiteral', key: K(sh.name, c.row, c.col), value: c.value })));
    edits.push({ kind: 'setCell', key: K('Q', 0, 0), raw: `=SQL("SELECT region, sum(amount) AS amount FROM ${name} WHERE active GROUP BY region ORDER BY region")` });
    edits.push({ kind: 'setCell', key: K('Q', 1, 0), raw: `=PY("t = inputs['A1']\nfloat(t['amount'].sum())")` });
    eng.applyEdits(edits);
    await eng.recalculate({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
    expect(eng.getValue(K(N, 1, 1))).toBe(249.5);
    expect(eng.getValue(K(N, 2, 1))).toMatchObject({ code: '#NAME?' });
    expect(eng.getValue(K(N, 4, 1))).toBe(161);
    expect(eng.getValue(K(N, 1, 2))).toBe('00123');
    expect(literalDisplay('00123')).toBe('00123');
    expect(eng.getValue(K(N, 1, 3))).toMatchObject({ code: '#N/A' });
    expect(eng.getValue(K('Q', 0, 0))).toMatchObject({ kind: 'table', rowCount: 2 });
    expect(eng.getValue(K('Q', 1, 0))).toBe(120 + 42 + 7);
  });
});

describe('shared-formula translation (property)', () => {
  const ref = fc.record({ absC: fc.boolean(), col: fc.integer({ min: 1, max: 60 }), absR: fc.boolean(), row: fc.integer({ min: 1, max: 500 }) });
  const letters = (n: number): string => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
  const text = (r: { absC: boolean; col: number; absR: boolean; row: number }): string => `${r.absC ? '$' : ''}${letters(r.col)}${r.absR ? '$' : ''}${r.row}`;
  const part = fc.oneof(
    ref.map(text),
    fc.tuple(ref, ref).map(([a, b]) => `${text(a)}:${text(b)}`),
    fc.constantFrom("'Q3 Plan'!", 'Sheet1!', "'It''s B2'!"),
    fc.string({ maxLength: 6 }).map((s) => `"${s.replaceAll('"', '""')}B7"`),
    fc.constantFrom('+', '*', '-', ',', 'SUM(', 'LOG10(', ')', '1.5', 'TRUE'),
  );
  it('shifting forward then back is the identity; quoted text and anchored parts never move', () => {
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 10 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), (parts, dr, dc) => {
        const f = parts.join('');
        const there = translateSharedFormula(f, 'C5', `${letters(3 + dc)}${5 + dr}`);
        const back = translateSharedFormula(there, `${letters(3 + dc)}${5 + dr}`, 'C5');
        expect(back).toBe(f);
        for (const q of f.match(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g) ?? []) expect(there).toContain(q);
      }),
      { numRuns: 1000, seed: 7301 },
    );
  });
});
