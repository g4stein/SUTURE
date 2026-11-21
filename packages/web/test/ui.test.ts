import { describe, expect, it } from 'vitest';
import { DEFAULT_EXORCIST, makeError, NEVER_CANCELLED, tableRefFromTable, toCellKey, type EngineOutcome, type PyEngine } from '@suture/core';
import { tableFromArrays } from 'apache-arrow';
import { engineLabel, formatNumber, formatValue, pillAccessibleName, pillText } from '../src/app/format.ts';
import { cellDisplay } from '../src/grid/cellDisplay.ts';
import { checkImport, importKind, MAX_IMPORT_BYTES } from '../src/import/routeFile.ts';
import { validateDocument } from '../src/import/validateDocument.ts';
import { gatedPyEngine, PY_BLOCKED_MESSAGE } from '../src/engines/gatedPy.ts';
import { previewTable } from '../src/inspector/preview.ts';
import { blankDocument } from '../src/workbooks/blank.ts';
import { saasRunwayDocument } from '../src/workbooks/saasRunway.ts';
import type { EngineState, EngineStatus } from '../src/workers/protocol.ts';

const st = (engine: 'duckdb' | 'pyodide', state: EngineState, extra: Partial<EngineStatus> = {}): EngineStatus => ({ engine, state, progress: null, reason: null, crashCount: 0, ...extra });

describe('readiness labels (Spec 04 §4, Req 4.1/4.3/4.5)', () => {
  it('maps every EngineState and uses the colon form', () => {
    expect(pillText(st('duckdb', 'notLoaded'))).toBe('DuckDB: Lazy');
    expect(pillText(st('pyodide', 'loading'))).toBe('Python/NumPy: Loading');
    expect(pillText(st('duckdb', 'ready'))).toBe('DuckDB: Ready');
    expect(pillText(st('pyodide', 'degraded'))).toBe('Python/NumPy: Degraded (restart on timeout)');
    expect(pillText(st('duckdb', 'failed'))).toBe('DuckDB: Failed');
  });
  it('shows a percentage only when the loader reports a total', () => {
    expect(engineLabel(st('duckdb', 'loading', { progress: { loadedBytes: 21, totalBytes: 50 } }))).toBe('Loading 42%');
    expect(engineLabel(st('duckdb', 'loading', { progress: { loadedBytes: 21, totalBytes: null } }))).toBe('Loading');
  });
  it('puts the full reason in the accessible name, prefixed with the engine', () => {
    const reason = 'timeouts restart the engine (page is not cross-origin isolated)';
    expect(pillAccessibleName(st('duckdb', 'degraded', { reason }))).toBe(`DuckDB: Degraded (restart on timeout). DuckDB: ${reason}`);
  });
});

describe('cell display (Spec 04 Req 1.4)', () => {
  it('formats to 12 significant digits with exponent thresholds', () => {
    expect(formatNumber(275710.021114032)).toBe('275710.021114');
    expect(formatNumber(1e15)).toBe('1e+15');
    expect(formatNumber(0.0000001)).toBe('1e-7');
    expect(formatValue(true)).toBe('TRUE');
  });
  it('builds badges for tables, matrices, errors, and pending cells', () => {
    const ref = tableRefFromTable(tableFromArrays({ a: Float64Array.from([1, 2, 3]), b: Float64Array.from([4, 5, 6]) }));
    expect(cellDisplay(ref, 'sql')).toMatchObject({ kind: 'table', text: '3 × 2', chip: 'sql' });
    expect(cellDisplay({ kind: 'matrix', rows: 1, cols: 2, data: Float64Array.from([1, 2]) }, 'py')).toMatchObject({ kind: 'matrix', text: 'matrix 1×2' });
    const e = cellDisplay(makeError('#DIV/0!', 'division by zero', 'Model!B5', 'formula'), 'formula');
    expect(e).toMatchObject({ kind: 'error', text: '#DIV/0!' });
    expect(e.title).toContain('origin Model!B5');
    expect(cellDisplay('pending', 'py')).toMatchObject({ kind: 'pending', chip: 'py' });
    expect(cellDisplay(42, 'literal')).toMatchObject({ kind: 'number', chip: null });
  });
});

describe('import routing and validation (Spec 04 Req 6.3, 6.4)', () => {
  it('routes by extension and rejects unknown kinds and oversize files', () => {
    expect(importKind('Q3 Orders.CSV')).toBe('csv');
    expect(importKind('a.parquet')).toBe('parquet');
    expect(importKind('Plan.xlsx')).toBe('xlsx');
    expect(importKind('model.suture.json')).toBe('suture');
    expect(importKind('suture-replay-1.json')).toBe('replay');
    expect(importKind('notes.docx')).toBeNull();
    expect(checkImport('notes.docx', 10)).toMatchObject({ ok: false });
    expect(checkImport('big.csv', MAX_IMPORT_BYTES + 1)).toMatchObject({ ok: false });
    expect(checkImport('ok.csv', 10)).toEqual({ ok: true, kind: 'csv' });
  });
  it('accepts the built-in documents and names the first failing path otherwise', () => {
    expect(validateDocument(JSON.parse(JSON.stringify(saasRunwayDocument()))).ok).toBe(true);
    expect(validateDocument(blankDocument()).ok).toBe(true);
    expect(validateDocument(null)).toEqual({ ok: false, path: '$', message: 'must be a JSON object' });
    const bad = JSON.parse(JSON.stringify(saasRunwayDocument())) as { exorcist: { assertions: Array<{ kind: string }> } };
    const first = bad.exorcist.assertions[0];
    if (first !== undefined) first.kind = 'approximately';
    expect(validateDocument(bad)).toMatchObject({ ok: false, path: '$.exorcist.assertions[0].kind' });
    expect(validateDocument({ ...blankDocument(), exorcist: { ...DEFAULT_EXORCIST, inputs: [{ cell: 'Sheet1!A1', domain: { kind: 'float', min: 2, max: 1 } }], assertions: [] } })).toMatchObject({ ok: false, path: '$.exorcist.inputs[0].domain' });
  });
});

describe('Python trust gate (Spec 04 Req 6.5)', () => {
  it('blocks gated cells with the exact message and never calls the inner engine', async () => {
    let calls = 0;
    const inner: PyEngine = {
      evaluate: async (): Promise<EngineOutcome> => { calls++; return { kind: 'value', value: 1 }; },
      evaluateBatch: async () => { calls++; return { kind: 'values', values: [1] }; },
    };
    const blocked = toCellKey({ sheet: 'Plan', row: 0, col: 0 });
    const gate = gatedPyEngine(inner, (c) => c === blocked);
    const r = await gate.evaluate({ cell: blocked, generation: 1, code: '1', vectorized: false, seed: 1, inputs: [] }, NEVER_CANCELLED);
    expect(r).toMatchObject({ kind: 'value', value: { kind: 'error', code: '#PY!', message: PY_BLOCKED_MESSAGE } });
    const b = await gate.evaluateBatch({ cell: blocked, generation: 1, code: '1', vectorized: false, seed: 1, shared: [], scenarios: [[], []] }, NEVER_CANCELLED);
    expect(b.kind === 'values' ? b.values.length : 0).toBe(2);
    expect(calls).toBe(0);
    await gate.evaluate({ cell: toCellKey({ sheet: 'Plan', row: 1, col: 0 }), generation: 1, code: '1', vectorized: false, seed: 1, inputs: [] }, NEVER_CANCELLED);
    expect(calls).toBe(1);
  });
});

describe('table preview (Spec 04 Req 3.3)', () => {
  it('decodes at most the first 100 rows of a 100,000-row table', () => {
    const n = 100_000;
    const ref = tableRefFromTable(tableFromArrays({ id: Float64Array.from({ length: n }, (_, i) => i), v: Float64Array.from({ length: n }, (_, i) => i * 0.5) }));
    const p = previewTable(ref);
    expect(p.decoded).toBe(100);
    expect(p.total).toBe(n);
    expect(p.rows[99]).toEqual(['99', '49.5']);
  });
});
