import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertCanonical, createWorkbookEngine, NEVER_CANCELLED, type CellValue } from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, workbook } from './helpers.ts';

const extreme = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(0, -0, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER, 1e-300, 2),
);

const SHAPES = [
  '=A1/A2', '=A1^A2', '=A1*A2*A3', '=SUM(A1:A3)*1e308', '=AVERAGE(A1:A3)', '=MAX(A1:A3)/A3', '=ROUND(A1/A2, 3)', '=(A1-A2)/(A2-A3)',
  '=A1%', '=-A1^0.5', '=IF(A2=0, A1, A1/A2)', '=IFERROR(A1^A3, A2)', '=A1+A2+A3', '=SUM(A1,A2)^2',
];

describe('numeric boundary', () => {
  it('no raw NaN or ±Infinity ever reaches a cell, for randomized extreme inputs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(extreme, extreme, extreme), async ([x, y, z]) => {
        const cells: Record<string, string> = {};
        SHAPES.forEach((f, i) => { cells[a1(i, 1)] = f; });
        const e = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
        e.applyEdits([
          { kind: 'setLiteral', key: key('Sheet1', 'A1'), value: x },
          { kind: 'setLiteral', key: key('Sheet1', 'A2'), value: y },
          { kind: 'setLiteral', key: key('Sheet1', 'A3'), value: z },
        ]);
        await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
        for (let i = 0; i < SHAPES.length; i++) {
          const v = e.getValue(key('Sheet1', a1(i, 1))) as CellValue;
          expect(() => assertCanonical(v)).not.toThrow();
          if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 1000, seed: 51 },
    );
  });
});
