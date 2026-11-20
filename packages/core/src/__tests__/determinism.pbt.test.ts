import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createWorkbookEngine, evaluatedLeaves, isCellError, NEVER_CANCELLED, parseFormula, sameValue, toCellKey,
  type CellValue, type Edit, type ScalarValue,
} from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, workbook } from './helpers.ts';

const OPTS = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 0 };

/** Formula cells B1..B6 over literal inputs A1..A4 and each other (acyclic: B_i only references B_j for j < i). */
const formulas = [
  '=A1+A2*2', '=IF(A3>0, B1/A3, A4)', '=SUM(A1:A4)-B2', '=ROUND(B3*1.5, 2)', '=IFERROR(B1/B2, 0)+MAX(A1, A2)', '=AVERAGE(B1, B4, A4)',
];
const scalar: fc.Arbitrary<ScalarValue> = fc.oneof(
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -5, max: 5 }),
  fc.constant(0), fc.constant(-0), fc.constant(null), fc.boolean(), fc.constantFrom('TRUE', '#N/A', '3', 'x'),
);

describe('determinism properties', () => {
  it('final values are independent of edit order, of incremental vs full recalc, and of topological tie-breaks', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(scalar, { minLength: 4, maxLength: 4 }), fc.array(fc.nat(), { minLength: 4, maxLength: 4 }), fc.integer(), async (inputs, perm, seed) => {
        const cells: Record<string, string> = {};
        formulas.forEach((f, i) => { cells[a1(i, 1)] = f; });
        const edits: Edit[] = inputs.map((v, i) => ({ kind: 'setLiteral', key: key('Sheet1', a1(i, 0)), value: v }));

        // (a) direct build: all literals present from the start
        const direct = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
        direct.applyEdits(edits);
        await direct.recalculateAll(OPTS);

        // (b) the same edits, one at a time, in a random order, recalculating incrementally after each
        const order = edits.map((e, i) => ({ e, k: perm[i] ?? 0 })).sort((x, y) => x.k - y.k).map((x) => x.e);
        const inc = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
        await inc.recalculateAll(OPTS);
        for (const e of order) {
          inc.applyEdits([e]);
          await inc.recalculate(OPTS);
        }

        // (c) seeded tie-break
        const seeded = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
        seeded.applyEdits(edits);
        await seeded.recalculateAll({ ...OPTS, tieBreak: { kind: 'seeded', seed } });

        for (let i = 0; i < formulas.length; i++) {
          const k = key('Sheet1', a1(i, 1));
          const v = direct.getValue(k) as CellValue;
          expect(sameValue(v, inc.getValue(k) as CellValue), `${k} incremental`).toBe(true);
          expect(sameValue(v, seeded.getValue(k) as CellValue), `${k} seeded`).toBe(true);
        }
      }),
      { numRuns: 300, seed: 31 },
    );
  });

  it('setLiteral is lossless (-0 and strings that look like other types)', async () => {
    for (const v of [-0, 'TRUE', '#N/A', '3', '', 1e-300] as ScalarValue[]) {
      const e = createWorkbookEngine(workbook({}), formulaOnlyDeps);
      e.applyEdits([{ kind: 'setLiteral', key: key('Sheet1', 'A1'), value: v }]);
      await e.recalculate(OPTS);
      expect(Object.is(e.getValue(key('Sheet1', 'A1')), v === '' ? '' : v)).toBe(true);
      expect(e.definition().sheets[0]?.cells[0]?.literal).toBe(v);
    }
  });

  it('IF short-circuit isolates errors in the untaken branch, and evaluatedLeaves reports only the taken path', async () => {
    const at = { sheet: 'Sheet1', row: 0, col: 3 };
    const ctx = { sheetNames: ['Sheet1'], names: new Map() };
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.constantFrom('#DIV/0!', '#N/A', '#NUM!', '#VALUE!'), fc.integer({ min: -100, max: 100 }), async (cond, code, n) => {
        const cells = { A1: cond ? 'TRUE' : 'FALSE', B1: code, C1: String(n), D1: '=IF(A1, C1, B1)', E1: '=IF(A1, B1, C1)' };
        const e = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
        await e.recalculateAll(OPTS);
        const d1 = e.getValue(key('Sheet1', 'D1')) as CellValue;
        const e1 = e.getValue(key('Sheet1', 'E1')) as CellValue;
        if (cond) {
          expect(d1).toBe(n);
          expect(e1).toMatchObject({ kind: 'error', code, origin: 'Sheet1!B1' });
        } else {
          expect(d1).toMatchObject({ kind: 'error', code, origin: 'Sheet1!B1' });
          expect(e1).toBe(n);
        }
        const parsed = parseFormula('IF(A1, C1, B1)', at, ctx);
        if (!parsed.ok) throw new Error('parse');
        const look = (c: string): CellValue => e.getValue(key('Sheet1', c)) as CellValue;
        const leaves = evaluatedLeaves(parsed.ast, at, (ref) => ({ kind: 'scalar', value: ref.kind === 'cell' ? look(toCellKey(ref.coord).split('!')[1] ?? '') : null }));
        const texts = leaves.map((l) => (l.kind === 'ref' ? l.ref.text : l.code));
        expect(texts).toEqual(cond ? ['A1', 'C1'] : ['A1', 'B1']);
        expect(isCellError(look('B1'))).toBe(true);
      }),
      { numRuns: 200, seed: 41 },
    );
  });
});
