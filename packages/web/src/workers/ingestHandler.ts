import type { Workbook } from 'exceljs';
import { Bool, Float64, Table, Utf8, tableToIPC, vectorFromArray, type Vector } from 'apache-arrow';
import { columnLetters, owned, type ScalarValue } from '@suture/core';
import type { IngestCell, WorkerResult, XlsxIngestResult } from './protocol.ts';
import type { JobHandler } from './workerRuntime.ts';

/**
 * Spec 02 §8 — spreadsheet-file ingest. Host-agnostic: the ingest worker passes exceljs's browser build; Node tests pass
 * the same build loaded from `exceljs/dist/exceljs.min.js`. Nothing leaves the machine: parsing happens on the bytes the
 * user dropped. Functions that Suture does not support are kept as written and evaluate to #NAME? (Spec 01 Req 6.3).
 */
export type WorkbookCtor = new () => Workbook;

const MAX_CELLS = 2_000_000;
/** Legacy spreadsheet serial dates count days from 1899-12-30. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

// exceljs ValueType enum values.
const VT = { Null: 0, Merge: 1, Number: 2, String: 3, Date: 4, Hyperlink: 5, Formula: 6, SharedString: 7, RichText: 8, Boolean: 9, Error: 10 } as const;

type Raw = { readonly kind: 'raw'; readonly raw: string } | { readonly kind: 'literal'; readonly value: ScalarValue } | null;

function serial(d: Date): number {
  return (d.getTime() - SERIAL_EPOCH_MS) / 86_400_000;
}

function plain(v: unknown): ScalarValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return serial(v);
  if (typeof v === 'object') {
    const o = v as { richText?: Array<{ text?: string }>; text?: unknown; error?: unknown; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? '').join('');
    if (typeof o.text === 'string') return o.text;
    if ('result' in o) return plain(o.result);
  }
  return null;
}

interface CellLike {
  readonly type: number;
  readonly value: unknown;
  readonly formula: string | undefined;
  readonly isMerged: boolean;
  readonly master: { readonly address: string };
  readonly address: string;
}

function convert(cell: CellLike, masterFormula: (address: string) => string | undefined): { readonly source: Raw; readonly tableValue: ScalarValue } {
  switch (cell.type) {
    case VT.Null:
    case VT.Merge:
      return { source: null, tableValue: null };
    case VT.Formula: {
      const shared = (cell.value as { sharedFormula?: unknown }).sharedFormula;
      const base = typeof shared === 'string' ? masterFormula(shared) : undefined;
      const f = typeof shared === 'string' ? (base === undefined ? undefined : translateSharedFormula(base, shared, cell.address)) : cell.formula;
      const result = plain(cell.value);
      return { source: f === undefined ? null : { kind: 'raw', raw: `=${f}` }, tableValue: result };
    }
    case VT.Error: {
      const e = (cell.value as { error?: unknown }).error;
      return { source: typeof e === 'string' ? { kind: 'raw', raw: e } : null, tableValue: null };
    }
    default: {
      const v = plain(cell.value);
      return { source: v === null ? null : { kind: 'literal', value: v }, tableValue: v };
    }
  }
}

const REF = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/y;

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function colLetters(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function addr(a: string): { row: number; col: number } {
  const m = /^([A-Z]+)([0-9]+)$/.exec(a.toUpperCase());
  return m === null ? { row: 0, col: 0 } : { row: Number(m[2]), col: colIndex(m[1] ?? 'A') };
}

/**
 * Translates a shared formula from its master cell to `target`: relative references shift by the row/column offset,
 * `$`-anchored parts stay. String literals ("…") and quoted sheet names ('…') are copied verbatim. exceljs's own
 * translator shifts text inside quoted sheet names ('Q3 Plan'!B2 became 'Q4 Plan'!B3), so Suture does not use it.
 */
export function translateSharedFormula(formula: string, master: string, target: string): string {
  const from = addr(master);
  const to = addr(target);
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i] ?? '';
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = formula[i - 1] ?? '';
    REF.lastIndex = i;
    const m = /[A-Za-z0-9_.]/.test(prev) ? null : REF.exec(formula);
    const after = m === null ? '' : formula[i + m[0].length] ?? '';
    if (m !== null && !/[A-Za-z0-9_.(!]/.test(after)) {
      const [, absC = '', letters = '', absR = '', digits = ''] = m;
      const col = absC === '$' ? colIndex(letters) : colIndex(letters) + dc;
      const row = absR === '$' ? Number(digits) : Number(digits) + dr;
      out += row < 1 || col < 1 ? '#REF!' : `${absC}${colLetters(col)}${absR}${row}`;
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function column(values: ReadonlyArray<ScalarValue>): Vector {
  if (values.every((v) => v === null || typeof v === 'number')) return vectorFromArray(values as Array<number | null>, new Float64());
  if (values.every((v) => v === null || typeof v === 'boolean')) return vectorFromArray(values as Array<boolean | null>, new Bool());
  return vectorFromArray(values.map((v) => (v === null ? null : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))), new Utf8());
}

export async function ingestXlsx(Ctor: WorkbookCtor, bytes: Uint8Array): Promise<XlsxIngestResult> {
  const wb = new Ctor();
  await wb.xlsx.load(bytes.slice().buffer);
  const sheets: Array<{ name: string; cells: IngestCell[] }> = [];
  const tables: Array<{ sheet: string; ipc: Uint8Array; header: 'firstRow' | 'columnLetters'; rowCount: number }> = [];
  const warnings: string[] = [];
  let total = 0;
  for (const ws of wb.worksheets) {
    const cells: IngestCell[] = [];
    const grid: ScalarValue[][] = [];
    let width = 0;
    let merged = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (c, colNumber) => {
        const cell = c as unknown as CellLike;
        if (cell.isMerged && cell.master.address !== cell.address) { merged++; return; }
        if (++total > MAX_CELLS) return;
        const { source, tableValue } = convert(cell, (a) => {
          const v = ws.getCell(a).value as { formula?: unknown } | null;
          return typeof v?.formula === 'string' ? v.formula : undefined;
        });
        const r = rowNumber - 1;
        const col = colNumber - 1;
        if (source !== null) cells.push(source.kind === 'raw' ? { row: r, col, kind: 'raw', raw: source.raw } : { row: r, col, kind: 'literal', value: source.value });
        (grid[r] ??= [])[col] = tableValue;
        width = Math.max(width, colNumber);
      });
    });
    if (merged > 0) warnings.push(`${ws.name}: ${merged} merged cell(s) beyond the top-left were skipped`);
    // exceljs keeps validation rules on an untyped `dataValidations.model` map.
    const validations = (ws as unknown as { dataValidations?: { model?: Record<string, unknown> } }).dataValidations?.model ?? {};
    if (Object.keys(validations).length > 0) warnings.push(`${ws.name}: data validation rules were skipped`);
    sheets.push({ name: ws.name, cells });
    const rows = grid.length;
    if (rows === 0 || width === 0) continue;
    const first = Array.from({ length: width }, (_, c) => grid[0]?.[c] ?? null);
    const header = first.every((v) => typeof v === 'string' && v.trim() !== '') && new Set(first.map((v) => String(v).toLowerCase())).size === width;
    const body = header ? grid.slice(1) : grid;
    const columns: Record<string, Vector> = {};
    for (let c = 0; c < width; c++) {
      const name = header ? String(first[c]) : columnLetters(c);
      columns[name] = column(Array.from({ length: body.length }, (_, r) => body[r]?.[c] ?? null));
    }
    tables.push({ sheet: ws.name, ipc: owned(tableToIPC(new Table(columns), 'stream')), header: header ? 'firstRow' : 'columnLetters', rowCount: body.length });
  }
  if (total > MAX_CELLS) warnings.push(`only the first ${MAX_CELLS.toLocaleString('en-US')} cells were imported`);
  return { sheets, tables, warnings };
}

export function createIngestHandler(Ctor: WorkbookCtor): JobHandler {
  return async (job): Promise<WorkerResult> => {
    const r = job.request;
    if (r.kind !== 'ingest.xlsx') return { kind: 'failed', message: `the ingest worker does not handle ${r.kind}` };
    try {
      return { kind: 'xlsx', workbook: await ingestXlsx(Ctor, r.payload.bytes) };
    } catch (e) {
      return { kind: 'failed', message: `could not read ${r.payload.fileName}: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}
