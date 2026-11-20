import * as fc from 'fast-check';
import FormulaParser from 'fast-formula-parser';
import { describe, expect, it } from 'vitest';
import { crossEngineClose, isCellError, parseFormula, printFormula } from '../index.ts';
import { formulaAst, safeArith, SHEET } from './arbitraries.ts';
import { build, val } from './helpers.ts';

const at = { sheet: SHEET, row: 0, col: 0 };
const ctx = { sheetNames: [SHEET], names: new Map() };

describe('parser properties', () => {
  it('parse(print(ast)) ≡ ast (structural round-trip)', () => {
    fc.assert(
      fc.property(formulaAst, (ast) => {
        const printed = printFormula(ast);
        const parsed = parseFormula(printed, at, ctx);
        expect(parsed.ok, `failed to parse ${printed}`).toBe(true);
        if (parsed.ok) expect(parsed.ast).toEqual(ast);
      }),
      { numRuns: 2000, seed: 20261120 },
    );
  });

  it('print(parse(s)) is a fixed point for every source that parses', () => {
    fc.assert(
      fc.property(formulaAst, (ast) => {
        const once = printFormula(ast);
        const r1 = parseFormula(once, at, ctx);
        if (!r1.ok) return;
        const twice = printFormula(r1.ast);
        expect(twice).toBe(once);
      }),
      { numRuns: 1000, seed: 7 },
    );
  });

  it('agrees with fast-formula-parser on error-free arithmetic (differential oracle)', async () => {
    const oracle = new FormulaParser({ onCell: () => 0, onRange: () => [[0]] });
    await fc.assert(
      fc.asyncProperty(safeArith, async (src) => {
        const expected = oracle.parse(src, { row: 1, col: 1, sheet: SHEET });
        const e = await build({ A1: `=${src}` });
        const got = val(e, 'A1');
        if (typeof expected === 'number') {
          expect(typeof got, `${src}: oracle ${expected}, suture ${JSON.stringify(got)}`).toBe('number');
          expect(crossEngineClose(got as number, expected), `${src}: oracle ${expected}, suture ${String(got)}`).toBe(true);
        } else {
          expect(isCellError(got), `${src}: oracle error, suture ${String(got)}`).toBe(true);
        }
      }),
      { numRuns: 500, seed: 424242 },
    );
  });
});
