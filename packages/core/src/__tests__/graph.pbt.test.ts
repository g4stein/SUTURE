import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createWorkbookEngine, isCellError, NEVER_CANCELLED, sameValue,
  type CellKey, type CellValue, type EngineEvent,
} from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, workbook } from './helpers.ts';

/** A random reference graph over cells A1..A{n}; each cell sums its references plus its own index. */
const graphArb = fc.integer({ min: 1, max: 14 }).chain((n) =>
  fc.tuple(fc.constant(n), fc.array(fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { maxLength: 3 }), { minLength: n, maxLength: n })),
);

function cellsOf(n: number, refs: number[][], acyclic: boolean): Record<string, string> {
  const cells: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const rs = (refs[i] ?? []).filter((j) => !acyclic || j < i);
    cells[a1(i, 0)] = rs.length === 0 ? String(i + 1) : `=${i + 1}+${rs.map((j) => a1(j, 0)).join('+')}`;
  }
  return cells;
}

function reach(n: number, refs: number[][]): boolean[][] {
  const r = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) for (const j of refs[i] ?? []) (r[i] as boolean[])[j] = true;
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (r[i]?.[k] && r[k]?.[j]) (r[i] as boolean[])[j] = true;
  return r;
}

describe('graph properties', () => {
  it('acyclic graphs: commit order is a valid topological order and values match a recursive reference', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, async ([n, refs]) => {
        const e = createWorkbookEngine(workbook(cellsOf(n, refs, true)), formulaOnlyDeps);
        const order: CellKey[] = [];
        e.subscribe((ev: EngineEvent) => { if (ev.kind === 'cellCommitted') order.push(ev.key); });
        await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
        const memo = new Map<number, number>();
        const ref = (i: number): number => {
          const m = memo.get(i);
          if (m !== undefined) return m;
          const v = (i + 1) + (refs[i] ?? []).filter((j) => j < i).reduce((s, j) => s + ref(j), 0);
          memo.set(i, v);
          return v;
        };
        for (let i = 0; i < n; i++) {
          const k = key('Sheet1', a1(i, 0));
          expect(e.getValue(k)).toBe(ref(i));
          for (const p of e.precedents(k)) expect(order.indexOf(p)).toBeLessThan(order.indexOf(k));
        }
      }),
      { numRuns: 300, seed: 11 },
    );
  });

  it('cyclic graphs: exactly the cells on a cycle get #CYCLE! (origin = self) with a valid shortest cycle path', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, async ([n, refs]) => {
        const e = createWorkbookEngine(workbook(cellsOf(n, refs, false)), formulaOnlyDeps);
        const res = await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
        const r = reach(n, refs);
        for (let i = 0; i < n; i++) {
          const k = key('Sheet1', a1(i, 0));
          const v = e.getValue(k) as CellValue;
          const onCycle = r[i]?.[i] === true;
          if (onCycle) {
            expect(v).toMatchObject({ kind: 'error', code: '#CYCLE!', origin: k });
            const report = res.cycles.find((c) => c.members.includes(k));
            const path = report?.paths.get(k) ?? [];
            expect(path[0]).toBe(k);
            expect(path[path.length - 1]).toBe(k);
            for (let s = 0; s + 1 < path.length; s++) expect(e.precedents(path[s] as CellKey)).toContain(path[s + 1]);
            // shortest: no shorter cycle through i exists (BFS over the reference relation)
            const dist = new Map<number, number>([[i, 0]]);
            const q = [i];
            let best = Infinity;
            while (q.length > 0) {
              const x = q.shift() as number;
              for (const y of refs[x] ?? []) {
                if (y === i) best = Math.min(best, (dist.get(x) ?? 0) + 1);
                if (!dist.has(y)) { dist.set(y, (dist.get(x) ?? 0) + 1); q.push(y); }
              }
            }
            expect(path.length - 1).toBe(best);
            expect((v as { message: string }).message).toMatch(/^cycle: A\d+( -> A\d+)+$/);
          } else if (isCellError(v)) {
            expect(v.code).toBe('#CYCLE!'); // downstream of a cycle: propagated, origin elsewhere
            expect(v.origin).not.toBe(k);
          }
        }
      }),
      { numRuns: 300, seed: 12 },
    );
  });

  it('breaking a cycle leaves no stale #CYCLE!', async () => {
    const e = createWorkbookEngine(workbook({ A1: '=B1', B1: '=C1', C1: '=A1', D1: '=A1+1' }), formulaOnlyDeps);
    await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
    expect(e.getValue(key('Sheet1', 'A1'))).toMatchObject({ code: '#CYCLE!', message: 'cycle: A1 -> B1 -> C1 -> A1' });
    e.applyEdits([{ kind: 'setCell', key: key('Sheet1', 'C1'), raw: '5' }]);
    await e.recalculate({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
    for (const [c, v] of [['A1', 5], ['B1', 5], ['C1', 5], ['D1', 6]] as const) expect(sameValue(e.getValue(key('Sheet1', c)) as CellValue, v)).toBe(true);
  });

  it('a range containing its own cell is a cycle', async () => {
    const e = createWorkbookEngine(workbook({ A1: '1', A2: '2', A5: '=SUM(A1:A10)' }), formulaOnlyDeps);
    await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
    expect(e.getValue(key('Sheet1', 'A5'))).toMatchObject({ code: '#CYCLE!', message: 'cycle: A5 -> A5' });
  });
});
