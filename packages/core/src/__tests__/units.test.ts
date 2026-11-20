import { describe, expect, it } from 'vitest';
import {
  assertCanonical, collapseSqlResult, CELL_ERROR_CODES, isCellError, normalizeMatrix, normalizeNumber, parseCellKey,
  rangeToTableRef, roundDecimal, toCellKey, type CellKey,
} from '../index.ts';
import { build, testHasher, val } from './helpers.ts';

const K = 'Sheet1!A1' as CellKey;

describe('value contract', () => {
  it('has exactly the 10 canonical error codes', () => {
    expect(CELL_ERROR_CODES).toEqual(['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#CYCLE!', '#NUM!', '#SQL!', '#PY!', '#TIMEOUT!']);
  });
  it('normalizes NaN and ±Infinity at the boundary', () => {
    expect(normalizeNumber(Number.NaN, 'none', K, 'py')).toMatchObject({ code: '#NUM!' });
    expect(normalizeNumber(Infinity, 'divisionByZero', K, 'py')).toMatchObject({ code: '#DIV/0!' });
    expect(normalizeNumber(-Infinity, 'none', K, 'sql')).toMatchObject({ code: '#NUM!' });
    expect(Object.is(normalizeNumber(-0, 'none', K, 'formula'), -0)).toBe(true);
    expect(normalizeMatrix({ kind: 'matrix', rows: 1, cols: 2, data: Float64Array.of(1, Number.NaN) }, 'none', K, 'py')).toMatchObject({ code: '#NUM!' });
    expect(() => assertCanonical(Number.NaN)).toThrow(/noNonFiniteLeak/);
  });
  it('collapses 1×1 SQL tables and keeps larger ones', () => {
    const one = rangeToTableRef(1, 1, 0, [42]);
    expect(collapseSqlResult(one, K)).toBe(42);
    const two = rangeToTableRef(2, 1, 0, [1, 2]);
    expect(collapseSqlResult(two, K)).toBe(two);
  });
  it('round-trips canonical cell keys', () => {
    for (const c of [{ sheet: 'Sheet1', row: 0, col: 0 }, { sheet: "Q3 'Plan'", row: 1_048_575, col: 16_383 }]) {
      expect(parseCellKey(toCellKey(c))).toEqual(c);
    }
    expect(toCellKey({ sheet: 'Sheet1', row: 6, col: 27 })).toBe('Sheet1!AB7');
  });
  it('sha256 known answer', async () => {
    const d = await testHasher.sha256(new Uint8Array([0x61, 0x62, 0x63]));
    expect([...d].map((x) => x.toString(16).padStart(2, '0')).join('')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('vertical-slice functions', () => {
  it('evaluates SUM / AVERAGE / MAX / ROUND', async () => {
    const e = await build({ A1: '1', A2: '2', A3: 'x', A4: '=SUM(A1:A3)', A5: '=AVERAGE(A1:A3)', A6: '=MAX(A1:A3, 7)', A7: '=ROUND(1.005, 2)', A8: '=ROUND(-2.5, 0)' });
    expect(val(e, 'A4')).toBe(3);
    expect(val(e, 'A5')).toBe(1.5);
    expect(val(e, 'A6')).toBe(7);
    expect(val(e, 'A7')).toBe(1.01);
    expect(val(e, 'A8')).toBe(-3);
    expect(roundDecimal(123.456, -1)).toBe(120);
  });
  it('unknown functions are #NAME? (including IFNA/ISERR/ISNA/ERROR.TYPE and the 23 Phase-3 functions)', async () => {
    const e = await build({ A1: '=IFNA(1,2)', A2: '=ISERR(1)', A3: '=ISNA(1)', A4: '=ERROR.TYPE(1)', A5: '=VLOOKUP(1,B1:C2,2)', A6: '=XLOOKUP(1)' });
    for (const a of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) expect(val(e, a)).toMatchObject({ kind: 'error', code: '#NAME?' });
  });
  it('IF short-circuits; IFERROR / ISERROR are the only interceptors', async () => {
    const e = await build({ B4: '0', A4: '10', C1: '=IF(B4=0, 0, A4/B4)', C2: '=IF(TRUE, 1/0, 1)', C3: '=IFERROR(A4/B4, -1)', C4: '=ISERROR(A4/B4)', C5: '=SUM(A4/B4, 1)', C6: '=IF(#N/A, 1, 2)' });
    expect(val(e, 'C1')).toBe(0);
    expect(val(e, 'C2')).toMatchObject({ code: '#DIV/0!' });
    expect(val(e, 'C3')).toBe(-1);
    expect(val(e, 'C4')).toBe(true);
    expect(val(e, 'C5')).toMatchObject({ code: '#DIV/0!', origin: 'Sheet1!C5' });
    expect(val(e, 'C6')).toMatchObject({ code: '#N/A' });
  });
  it('propagates the first upstream error unchanged', async () => {
    const e = await build({ B1: '=1/0', B2: '#N/A', B3: '=B2', C1: '=SUM(B1:B3)', C2: '=B3+B1' });
    expect(val(e, 'C1')).toMatchObject({ code: '#DIV/0!', origin: 'Sheet1!B1' });
    expect(val(e, 'C2')).toMatchObject({ code: '#N/A', origin: 'Sheet1!B2' });
  });
  it('-2^2 = 4, 0^0 = #NUM!, 0^-1 = #DIV/0!, overflow = #NUM!', async () => {
    const e = await build({ A1: '=-2^2', A2: '=0^0', A3: '=0^-1', A4: '=1e308*10', A5: '=2^0.5' });
    expect(val(e, 'A1')).toBe(4);
    expect(val(e, 'A2')).toMatchObject({ code: '#NUM!' });
    expect(val(e, 'A3')).toMatchObject({ code: '#DIV/0!' });
    expect(val(e, 'A4')).toMatchObject({ code: '#NUM!' });
    expect(val(e, 'A5')).toBe(Math.SQRT2);
  });
  it('parse errors give #VALUE! with an offset; engine calls must be whole-cell', async () => {
    const e = await build({ A1: '=1+', A2: '=1+SQL("SELECT 1")', A3: '=SUM(1))' });
    expect(val(e, 'A1')).toMatchObject({ code: '#VALUE!' });
    expect(String(isCellError(val(e, 'A1')) ? (val(e, 'A1') as { message: string }).message : '')).toMatch(/offset 3/);
    expect(val(e, 'A2')).toMatchObject({ code: '#VALUE!' });
    expect(val(e, 'A3')).toMatchObject({ code: '#VALUE!' });
  });
});
