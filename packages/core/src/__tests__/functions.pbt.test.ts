import * as fc from 'fast-check';
import FormulaParser from 'fast-formula-parser';
import { describe, expect, it } from 'vitest';
import {
  assertCanonical, createWorkbookEngine, crossEngineClose, evaluatedLeaves, isCellError, NEVER_CANCELLED, parseFormula,
  type CellValue, type FormulaAst, type WorkbookEngine,
} from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, val, workbook } from './helpers.ts';

const OPTS = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 0 };

async function run(cells: Record<string, string>): Promise<WorkbookEngine> {
  const e = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
  await e.recalculateAll(OPTS);
  return e;
}

/** Literal cell sources (no error literals: errors are covered by the propagation tests). */
const member = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -5, max: 5 }).map(String) },
  { weight: 1, arbitrary: fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }).filter((x) => !Object.is(x, -0)).map(String) },
  { weight: 2, arbitrary: fc.constantFrom('a', 'A', 'ab', 'b', 'Ba', 'a*', '') },
  { weight: 1, arbitrary: fc.constantFrom('TRUE', 'FALSE') },
);
const criterion = fc.oneof(
  fc.tuple(fc.constantFrom('', '=', '<>', '<', '>', '<=', '>='), fc.integer({ min: -5, max: 5 })).map(([op, n]) => `${op}${n}`),
  fc.tuple(fc.constantFrom('', '=', '<>'), fc.constantFrom('a', 'A*', '?', 'b*', 'a~*', '')).map(([op, s]) => `${op}${s}`),
  fc.constantFrom('TRUE', '<>FALSE', '<b', '>=a'),
);
const q = (s: string): string => `"${s.replaceAll('"', '""')}"`;

function column(values: ReadonlyArray<string>, col: number): Record<string, string> {
  const out: Record<string, string> = {};
  values.forEach((v, i) => { if (v !== '') out[a1(i, col)] = v; });
  return out;
}

describe('function properties', () => {
  it('conditional aggregation obeys complement, decomposition, and single-pair identities', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(member, { minLength: 1, maxLength: 12 }), fc.array(fc.integer({ min: -9, max: 9 }), { minLength: 12, maxLength: 12 }), criterion, async (xs, ys, c) => {
        const n = xs.length;
        const R = `A1:A${n}`;
        const S = `B1:B${n}`;
        const neg = c.startsWith('<>') ? `=${c.slice(2)}` : c.startsWith('=') ? `<>${c.slice(1)}` : /^[<>]/.test(c) ? null : `<>${c}`;
        const cells = {
          ...column(xs, 0), ...column(ys.slice(0, n).map(String), 1),
          D1: `=COUNTIF(${R}, ${q(c)})`, D2: neg === null ? '0' : `=COUNTIF(${R}, ${q(neg)})`, D3: `=COUNTA(${R})+COUNTIF(${R}, "")`,
          D4: `=SUMIF(${R}, ${q(c)}, ${S})`, D5: `=SUMIFS(${S}, ${R}, ${q(c)})`, D6: `=COUNTIFS(${R}, ${q(c)})`,
          D7: `=AVERAGEIF(${R}, ${q(c)}, ${S})`, D8: `=SUMIFS(${S}, ${R}, ${q(c)}, ${R}, ${q(c)})`,
        };
        const e = await run(cells);
        const v = (k: string): CellValue => val(e, k);
        // complement: a criterion and its negation partition the range (blank cells count once via COUNTIF(..., ""))
        if (neg !== null && !/^[<>]=?[a-z]/i.test(c)) expect((v('D1') as number) + (v('D2') as number), `${c} | ${neg}`).toBe(n);
        expect(v('D4')).toBe(v('D5'));
        expect(v('D6')).toBe(v('D1'));
        expect(v('D8')).toBe(v('D4'));
        if (v('D1') === 0) expect(v('D7')).toMatchObject({ code: '#DIV/0!' });
        else expect(crossEngineClose(v('D7') as number, (v('D4') as number) / (v('D1') as number))).toBe(true);
        expect(v('D3')).toBeGreaterThanOrEqual(n);
      }),
      { numRuns: 400, seed: 6101 },
    );
  });

  it('numeric criteria: COUNTIF(">k") + COUNTIF("<=k") equals COUNT', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(member, { minLength: 1, maxLength: 15 }), fc.integer({ min: -6, max: 6 }), async (xs, k) => {
        const R = `A1:A${xs.length}`;
        const e = await run({ ...column(xs, 0), C1: `=COUNTIF(${R}, ">${k}")+COUNTIF(${R}, "<=${k}")`, C2: `=COUNT(${R})` });
        expect(val(e, 'C1')).toBe(val(e, 'C2'));
      }),
      { numRuns: 300, seed: 6102 },
    );
  });

  it('lookups: VLOOKUP / MATCH / INDEX agree on unique keys, and misses are #N/A', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 10 }), fc.integer({ min: -60, max: 60 }), async (keys, probe) => {
        const sorted = [...keys].sort((a, b) => a - b);
        const n = sorted.length;
        const cells: Record<string, string> = {
          ...column(sorted.map(String), 0), ...column(sorted.map((k) => String(k * 3 + 1)), 1),
          D1: `=VLOOKUP(${probe}, A1:B${n}, 2, FALSE)`, D2: `=MATCH(${probe}, A1:A${n}, 0)`, D3: `=INDEX(B1:B${n}, MATCH(${probe}, A1:A${n}, 0))`,
          D4: `=MATCH(${probe}, A1:A${n}, 1)`, D5: `=VLOOKUP(${probe}, A1:B${n}, 2, TRUE)`, D6: `=COUNTIF(A1:A${n}, "<=${probe}")`,
        };
        const e = await run(cells);
        const pos = sorted.indexOf(probe);
        if (pos < 0) {
          expect(val(e, 'D1')).toMatchObject({ code: '#N/A' });
          expect(val(e, 'D2')).toMatchObject({ code: '#N/A' });
          expect(val(e, 'D3')).toMatchObject({ code: '#N/A' });
        } else {
          expect(val(e, 'D1')).toBe(probe * 3 + 1);
          expect(val(e, 'D2')).toBe(pos + 1);
          expect(val(e, 'D3')).toBe(probe * 3 + 1);
        }
        const below = val(e, 'D6') as number;
        if (below === 0) {
          expect(val(e, 'D4')).toMatchObject({ code: '#N/A' });
          expect(val(e, 'D5')).toMatchObject({ code: '#N/A' });
        } else {
          expect(val(e, 'D4')).toBe(below);
          expect(val(e, 'D5')).toBe((sorted[below - 1] ?? 0) * 3 + 1);
        }
      }),
      { numRuns: 400, seed: 6103 },
    );
  });

  it('financial: NPV of the PMT annuity equals the principal; IRR is a root of NPV or #NUM!', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.001, max: 0.3, noNaN: true }), fc.integer({ min: 1, max: 60 }), fc.double({ min: 100, max: 1e6, noNaN: true }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 2, maxLength: 8 }),
        async (rate, nper, pv, flows) => {
          const cells: Record<string, string> = { A1: String(rate), A2: String(nper), A3: String(pv), B1: '=PMT(A1, A2, A3)' };
          for (let i = 0; i < nper; i++) cells[a1(i, 2)] = '=-B1';
          cells['B2'] = `=NPV(A1, C1:C${nper})`;
          flows.forEach((f, i) => { cells[a1(i, 3)] = String(f); });
          cells['B3'] = `=IRR(D1:D${flows.length})`;
          const e = await run(cells);
          expect(crossEngineClose(val(e, 'B2') as number, pv) || Math.abs((val(e, 'B2') as number) - pv) < 1e-6 * pv).toBe(true);
          const r = val(e, 'B3');
          assertCanonical(r);
          if (isCellError(r)) {
            expect(r.code).toBe('#NUM!');
          } else {
            const npv = flows.reduce((s, f, t) => s + f / (1 + (r as number)) ** t, 0);
            expect(Math.abs(npv)).toBeLessThan(1e-6 * Math.max(1, ...flows.map(Math.abs)));
          }
        },
      ),
      { numRuns: 300, seed: 6104 },
    );
  });

  it('agrees with fast-formula-parser on the 16 functions it evaluates, over numeric grids', async () => {
    const fns = ['ABS(X)', 'SQRT(ABS(X))', 'MOD(X, Y)', 'POWER(X, 2)', 'ROUND(X, 1)', 'AND(X, Y)', 'OR(X, 0)', 'NOT(X)', 'ISNUMBER(X)', 'ISBLANK(X)',
      'COUNT(G)', 'SUMIF(G, ">1")', 'COUNTIF(G, "<=2")', 'AVERAGEIF(G, ">=0")', 'VLOOKUP(Y, T, 2, FALSE)', 'INDEX(G, 2, 2)'];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: -4, max: 4 }), { minLength: 9, maxLength: 9 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: -4, max: 4 }), fc.nat(fns.length - 1),
        async (grid, x, y, fi) => {
          const data = [grid.slice(0, 3), grid.slice(3, 6), grid.slice(6, 9)];
          const oracle = new FormulaParser({
            onCell: ({ row, col }) => data[row - 1]?.[col - 1] ?? null,
            onRange: (r) => {
              const ref = r as { from: { row: number; col: number }; to: { row: number; col: number } };
              const out: Array<Array<number | null>> = [];
              for (let i = ref.from.row; i <= ref.to.row; i++) {
                const row: Array<number | null> = [];
                for (let j = ref.from.col; j <= ref.to.col; j++) row.push(data[i - 1]?.[j - 1] ?? null);
                out.push(row);
              }
              return out;
            },
          });
          const f = (fns[fi] ?? 'ABS(X)').replaceAll('X', String(x)).replaceAll('Y', String(y)).replaceAll('G', 'A1:C3').replaceAll('T', 'A1:B3');
          const cells: Record<string, string> = { E1: `=${f}` };
          data.forEach((row, i) => row.forEach((v, j) => { cells[a1(i, j)] = String(v); }));
          const e = await run(cells);
          const got = val(e, 'E1');
          let want: unknown;
          try { want = oracle.parse(f, { row: 9, col: 9, sheet: 'Sheet1' }); } catch { return; }
          if (typeof want === 'number') expect(crossEngineClose(got as number, want), `${f}: oracle ${want}, suture ${JSON.stringify(got)}`).toBe(true);
          else if (typeof want === 'boolean') expect(got, f).toBe(want);
          else expect(isCellError(got), `${f}: oracle ${JSON.stringify(want)}, suture ${JSON.stringify(got)}`).toBe(true);
        }),
      { numRuns: 800, seed: 6105 },
    );
  });

  it('nested IF: the value follows the taken path, and evaluatedLeaves lists only that path', async () => {
    type T = { kind: 'leaf'; cell: number } | { kind: 'if'; cond: number; then: T; else: T };
    const tree: fc.Arbitrary<T> = fc.letrec<{ t: T }>((tie) => ({
      t: fc.oneof({ depthSize: 'small' },
        fc.integer({ min: 0, max: 5 }).map((cell) => ({ kind: 'leaf' as const, cell })),
        fc.record({ kind: fc.constant('if' as const), cond: fc.integer({ min: 0, max: 3 }), then: tie('t'), else: tie('t') })),
    })).t;
    const src = (t: T): string => (t.kind === 'leaf' ? `B${t.cell + 1}` : `IF(A${t.cond + 1}, ${src(t.then)}, ${src(t.else)})`);
    await fc.assert(
      fc.asyncProperty(tree, fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), fc.array(fc.oneof(fc.integer({ min: -9, max: 9 }).map(String), fc.constantFrom('#N/A', '#DIV/0!', '#NUM!')), { minLength: 6, maxLength: 6 }),
        async (t, conds, leaves) => {
          const cells: Record<string, string> = { C1: `=${src(t)}` };
          conds.forEach((b, i) => { cells[`A${i + 1}`] = b ? 'TRUE' : 'FALSE'; });
          leaves.forEach((l, i) => { cells[`B${i + 1}`] = l; });
          const e = await run(cells);
          const path: string[] = [];
          let cur = t;
          while (cur.kind === 'if') { path.push(`A${cur.cond + 1}`); cur = conds[cur.cond] === true ? cur.then : cur.else; }
          path.push(`B${cur.cell + 1}`);
          const leaf = leaves[cur.cell] ?? '0';
          const v = val(e, 'C1');
          if (leaf.startsWith('#')) expect(v).toMatchObject({ kind: 'error', code: leaf, origin: key('Sheet1', `B${cur.cell + 1}`) });
          else expect(v).toBe(Number(leaf));
          const parsed = parseFormula(src(t), { sheet: 'Sheet1', row: 0, col: 2 }, { sheetNames: ['Sheet1'], names: new Map() });
          if (!parsed.ok) throw new Error(parsed.message);
          const look = (ast: FormulaAst): void => void ast;
          look(parsed.ast);
          const listed = evaluatedLeaves(parsed.ast, { sheet: 'Sheet1', row: 0, col: 2 }, (ref) => ({
            kind: 'scalar', value: ref.kind === 'cell' ? (e.getValue(key('Sheet1', ref.text)) as CellValue) : null,
          })).map((l) => (l.kind === 'ref' ? l.ref.text : l.code));
          expect(listed).toEqual(path);
        }),
      { numRuns: 400, seed: 6106 },
    );
  });
});
