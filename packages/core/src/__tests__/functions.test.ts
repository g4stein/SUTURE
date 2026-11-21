import { describe, expect, it } from 'vitest';
import { FUNCTIONS, type CellValue } from '../index.ts';
import { build, val } from './helpers.ts';

/** Spec 01 §6.4 conformance table: one row per edge case, for every one of the 30 functions. */
const DATA: Record<string, string> = {
  A1: '1', A2: '2', A3: '3', A4: 'x', A5: '', B1: 'a', B2: 'b', B3: 'B', B4: 'a*', B5: 'TRUE',
  C1: '10', C2: '20', C3: '30', C4: '40', D1: '1', D2: '2', D3: '4', D4: '8',
  E1: '-1000', E2: '300', E3: '400', E4: '500',
  F1: '1', F2: 'one', F3: '2', F4: 'two', F5: '4', F6: 'four',
  G1: '=1/0', H1: '0',
};

type Expect = number | string | boolean | null | { readonly code: string };

const ROWS: ReadonlyArray<readonly [string, Expect]> = [
  ['=SUM(A1:A4, 4)', 10], ['=SUM(A4:A5)', 0], ['=SUM(A1:A3, "2")', 8], ['=SUM(A1, G1)', { code: '#DIV/0!' }],
  ['=AVERAGE(A1:A4)', 2], ['=AVERAGE(A4:A5)', { code: '#DIV/0!' }],
  ['=MIN(A1:A3, 0.5)', 0.5], ['=MIN(A4:A5)', 0], ['=MAX(A1:A3)', 3], ['=MAX(A4:A5)', 0],
  ['=COUNT(A1:A5, 7, "x")', 4], ['=COUNTA(A1:A5)', 4], ['=COUNTA(A5)', 0],
  ['=ROUND(1.005, 2)', 1.01], ['=ROUND(-2.5, 0)', -3], ['=ROUND(1234.5, -2)', 1200], ['=ROUND(1, 400)', { code: '#NUM!' }],
  ['=ABS(-2.5)', 2.5], ['=POWER(2, 10)', 1024], ['=POWER(0, 0)', { code: '#NUM!' }], ['=POWER(0, -1)', { code: '#DIV/0!' }], ['=POWER(-8, 0.5)', { code: '#NUM!' }],
  ['=SQRT(16)', 4], ['=SQRT(-1)', { code: '#NUM!' }],
  ['=MOD(5, 0)', { code: '#DIV/0!' }], ['=MOD(-5, 3)', 1], ['=MOD(5, -3)', -1],
  ['=SUMIF(A1:A3, ">1")', 5], ['=SUMIF(A1:A3, ">=2", C1:C3)', 50], ['=SUMIF(B1:B3, "b", C1:C3)', 50], ['=SUMIF(A1:A3, ">1", C1:C2)', { code: '#VALUE!' }],
  ['=SUMIF(B1:B4, "a~*", C1:C4)', 40], ['=SUMIF(B1:B4, "a*", C1:C4)', 50], ['=SUMIF(A1:A3, "<>2", C1:C3)', 40], ['=SUMIF(A1:A5, "", C1:C5)', 0],
  ['=SUMIFS(C1:C3, A1:A3, ">1", B1:B3, "b")', 50], ['=SUMIFS(C1:C3, A1:A3, ">1", B1:B2, "b")', { code: '#VALUE!' }], ['=SUMIFS(C1:C3, A1:A3)', { code: '#VALUE!' }],
  ['=COUNTIF(A1:A4, "<>x")', 3], ['=COUNTIF(B1:B3, "B")', 2], ['=COUNTIF(A1:A3, "<=2")', 2], ['=COUNTIF(A1:A5, "")', 1], ['=COUNTIF(G1:H1, ">0")', { code: '#DIV/0!' }],
  ['=COUNTIFS(A1:A3, ">1", C1:C3, "<30")', 1], ['=COUNTIFS(A1:A3, ">1", C1:C4, "<30")', { code: '#VALUE!' }],
  ['=AVERAGEIF(A1:A3, ">1", C1:C3)', 25], ['=AVERAGEIF(A1:A3, ">5")', { code: '#DIV/0!' }],
  ['=IF(H1=0, 0, A1/H1)', 0], ['=IF(A1, G1, 2)', { code: '#DIV/0!' }], ['=IF(FALSE, G1, 2)', 2], ['=IF(FALSE, 1)', false], ['=IF("maybe", 1, 2)', { code: '#VALUE!' }],
  ['=AND(TRUE, 1, A1:A3)', true], ['=AND(A4:A5)', { code: '#VALUE!' }], ['=OR(FALSE, 0)', false], ['=OR(H1, B5)', true], ['=NOT(0)', true], ['=AND(TRUE, G1)', { code: '#DIV/0!' }],
  ['=IFERROR(G1, 7)', 7], ['=IFERROR(3, 7)', 3], ['=ISERROR(G1)', true], ['=ISERROR(A1)', false],
  ['=ISBLANK(A5)', true], ['=ISBLANK(A4)', false], ['=ISBLANK(G1)', { code: '#DIV/0!' }], ['=ISNUMBER(A1)', true], ['=ISNUMBER("1")', false], ['=ISNUMBER(G1)', { code: '#DIV/0!' }],
  ['=VLOOKUP(2, D1:F6, 2, FALSE)', 300], ['=VLOOKUP(4, F1:F6, 1, FALSE)', 4], ['=VLOOKUP(3, A1:C3, 3, FALSE)', 30], ['=VLOOKUP(9, A1:C3, 3, FALSE)', { code: '#N/A' }],
  ['=VLOOKUP(2.5, A1:C3, 3)', 20], ['=VLOOKUP(0, A1:C3, 3, TRUE)', { code: '#N/A' }], ['=VLOOKUP(2, A1:C3, 4, FALSE)', { code: '#REF!' }], ['=VLOOKUP(2, A1:C3, 0, FALSE)', { code: '#VALUE!' }],
  ['=VLOOKUP("B", B1:C3, 2, FALSE)', 20], ['=VLOOKUP(G1, A1:C3, 2)', { code: '#DIV/0!' }],
  ['=INDEX(C1:C4, 3)', 30], ['=INDEX(A1:C3, 2, 3)', 20], ['=INDEX(A1:C3, 0, 1)', { code: '#REF!' }], ['=INDEX(A1:C3, 4, 1)', { code: '#REF!' }],
  ['=MATCH(4, D1:D4, 0)', 3], ['=MATCH(5, D1:D4, 1)', 3], ['=MATCH(5, D1:D4)', 3], ['=MATCH(0, D1:D4, 1)', { code: '#N/A' }], ['=MATCH(9, D1:D4, 0)', { code: '#N/A' }],
  ['=MATCH("b", B1:B3, 0)', 2], ['=MATCH(1, A1:C3, 0)', { code: '#N/A' }],
  ['=ROUND(NPV(0.1, 110, 121), 9)', 200], ['=NPV(-1, 1, 2)', { code: '#DIV/0!' }], ['=PMT(0, 10, 1000)', -100], ['=PMT(0.1, 0, 1000)', { code: '#NUM!' }],
  ['=ROUND(PMT(0.05, 10, 1000), 6)', -129.504575], ['=ROUND(IRR(E1:E4), 9)', 0.088963395], ['=IRR(C1:C4)', { code: '#NUM!' }],
];

function cells(formulas: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = { ...DATA };
  formulas.forEach((f, i) => { out[`Z${i + 1}`] = f; });
  return out;
}

describe('Spec 01 §6.4 conformance (all 30 functions)', () => {
  it('registers exactly the 30 functions of Spec 01 Req 6.1', () => {
    expect([...FUNCTIONS.keys()].sort()).toEqual([
      'ABS', 'AND', 'AVERAGE', 'AVERAGEIF', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'IF', 'IFERROR', 'INDEX', 'IRR', 'ISBLANK', 'ISERROR', 'ISNUMBER',
      'MATCH', 'MAX', 'MIN', 'MOD', 'NOT', 'NPV', 'OR', 'PMT', 'POWER', 'ROUND', 'SQRT', 'SUM', 'SUMIF', 'SUMIFS', 'VLOOKUP',
    ]);
    const covered = new Set(ROWS.flatMap(([f]) => [...f.matchAll(/([A-Z]+)\(/g)].map((m) => m[1])));
    for (const fn of FUNCTIONS.keys()) expect(covered.has(fn), `${fn} has a conformance row`).toBe(true);
  });

  it('evaluates every conformance row', async () => {
    const e = await build(cells(ROWS.map(([f]) => f)));
    ROWS.forEach(([f, want], i) => {
      const got: CellValue = val(e, `Z${i + 1}`);
      if (want !== null && typeof want === 'object') expect(got, f).toMatchObject({ kind: 'error', code: want.code });
      else expect(got, f).toBe(want);
    });
  });
});
