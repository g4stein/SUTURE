import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createWorkbookEngine, NEVER_CANCELLED, sameValue,
  type CellKey, type CellValue, type Edit, type EngineDeps, type EngineEvent, type WorkbookDefinition, type WorkbookEngine,
} from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, workbook } from './helpers.ts';

/**
 * Spec 01 §7.1 / §7.3, Req 10.7, Req 11.2: the incrementally maintained dependency graph, the deferred dirty-set
 * expansion, and the sliced preamble must be invisible: same edges as a rebuilt graph, same values as a full
 * recalculation, and the same commit order with and without yielding.
 */
const OPTS = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 0 };
const ROWS = 4;
const COLS = 3;
const grid: CellKey[] = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid.push(key('Sheet1', a1(r, c)));

const ref = fc.tuple(fc.integer({ min: 0, max: ROWS - 1 }), fc.integer({ min: 0, max: COLS - 1 })).map(([r, c]) => a1(r, c));
const rangeRef = fc.tuple(ref, ref).map(([x, y]) => `${x}:${y}`);
/** Cell contents: literals, clears, formulas over cells and ranges (self-references and cycles included). */
const raw: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: -9, max: 9 }).map(String),
  fc.constant(''),
  fc.array(ref, { minLength: 1, maxLength: 3 }).map((rs) => `=1+${rs.join('+')}`),
  rangeRef.map((r) => `=SUM(${r})`),
  fc.tuple(rangeRef, ref).map(([r, x]) => `=COUNT(${r})+${x}`),
);
const edit: fc.Arbitrary<Edit> = fc.tuple(fc.constantFrom(...grid), raw).map(([k, r]) =>
  r === '' ? { kind: 'clearCell', key: k } : { kind: 'setCell', key: k, raw: r });
const batches = fc.array(fc.array(edit, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 8 });
const initial = fc.array(raw, { minLength: grid.length, maxLength: grid.length });

function build(contents: ReadonlyArray<string>, deps: EngineDeps = formulaOnlyDeps): WorkbookEngine {
  const cells: Record<string, string> = {};
  contents.forEach((r, i) => {
    if (r !== '') cells[(grid[i] as string).slice('Sheet1!'.length)] = r;
  });
  return createWorkbookEngine(workbook(cells), deps);
}

function rebuilt(e: WorkbookEngine): WorkbookEngine {
  const def: WorkbookDefinition = e.definition();
  return createWorkbookEngine(def, formulaOnlyDeps);
}

describe('incremental graph and deferred dirty set', () => {
  it('edges after any edit sequence equal a rebuilt graph, and values equal a full recalculation', async () => {
    await fc.assert(
      fc.asyncProperty(initial, batches, async (start, seq) => {
        const inc = build(start);
        await inc.recalculateAll(OPTS);
        for (const batch of seq) {
          inc.applyEdits(batch);
          await inc.recalculate(OPTS);
          const fresh = rebuilt(inc);
          await fresh.recalculateAll(OPTS);
          for (const k of grid) {
            expect(inc.precedents(k), `precedents ${k}`).toEqual(fresh.precedents(k));
            expect(inc.dependents(k), `dependents ${k}`).toEqual(fresh.dependents(k));
            expect(sameValue(inc.getValue(k) as CellValue, fresh.getValue(k) as CellValue), `value ${k}`).toBe(true);
          }
        }
      }),
      { numRuns: 300, seed: 5051 },
    );
  });

  it('graphVersion moves only when an edge changes', async () => {
    const e = createWorkbookEngine(workbook({ A1: '1', B1: '=A1*2', C1: '=SUM(A1:A3)' }), formulaOnlyDeps);
    await e.recalculateAll(OPTS);
    const v0 = e.graphVersion();
    e.applyEdits([{ kind: 'setLiteral', key: key('Sheet1', 'A1'), value: 5 }]);
    await e.recalculate(OPTS);
    expect(e.graphVersion()).toBe(v0);
    expect(e.getValue(key('Sheet1', 'B1'))).toBe(10);
    e.applyEdits([{ kind: 'setCell', key: key('Sheet1', 'A2'), raw: '7' }]); // creates a member of C1's range
    await e.recalculate(OPTS);
    expect(e.graphVersion()).toBeGreaterThan(v0);
    expect(e.precedents(key('Sheet1', 'C1'))).toEqual([key('Sheet1', 'A1'), key('Sheet1', 'A2')]);
    expect(e.getValue(key('Sheet1', 'C1'))).toBe(12);
  });
});

/** A clock that advances one unit per read, and a yield hook: slicing behaves the same on every machine. */
function slicedDeps(onYield: () => void = () => undefined): { deps: EngineDeps; yields: () => number } {
  let t = 0;
  let n = 0;
  return {
    deps: { ...formulaOnlyDeps, clock: { now: () => (t += 1) }, yieldControl: () => { n++; onYield(); return Promise.resolve(); } },
    yields: () => n,
  };
}

function commitOrder(e: WorkbookEngine): CellKey[] {
  const order: CellKey[] = [];
  e.subscribe((ev: EngineEvent) => { if (ev.kind === 'cellCommitted') order.push(ev.key); });
  return order;
}

describe('time-sliced recalculation (Req 10.7)', () => {
  it('yielding never changes values or commit order, cycles included', async () => {
    await fc.assert(
      fc.asyncProperty(initial, fc.array(edit, { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 4 }), async (start, batch, slice) => {
        const plain = build(start);
        await plain.recalculateAll(OPTS);
        const plainOrder = commitOrder(plain);
        plain.applyEdits(batch);
        const r0 = await plain.recalculate(OPTS);

        const s = slicedDeps();
        const sliced = build(start, s.deps);
        await sliced.recalculateAll(OPTS);
        const slicedOrder = commitOrder(sliced);
        sliced.applyEdits(batch);
        const r1 = await sliced.recalculate({ ...OPTS, sliceMs: slice });

        expect(slicedOrder).toEqual(plainOrder);
        expect(r1.cycles.map((c) => c.members)).toEqual(r0.cycles.map((c) => c.members));
        for (const k of grid) expect(sameValue(sliced.getValue(k) as CellValue, plain.getValue(k) as CellValue), k).toBe(true);
      }),
      { numRuns: 300, seed: 6061 },
    );
  });

  it('Spec 01 task 7.5: with a clock advancing 1 ms per evaluated cell and sliceMs 8, 1,000 cells yield 124 or 125 times', async () => {
    let now = 0;
    let yields = 0;
    const deps: EngineDeps = { ...formulaOnlyDeps, clock: { now: () => now }, yieldControl: () => { yields++; return Promise.resolve(); } };
    const def: WorkbookDefinition = {
      sheets: [{ name: 'S', cells: [{ key: key('S', 'A1'), raw: '1' }, ...Array.from({ length: 999 }, (_, i) => ({ key: key('S', `B${i + 1}`), raw: `=A1+${i}` }))] }],
      names: [], datasets: [], seed: 1,
    };
    const sliced = createWorkbookEngine(def, deps);
    sliced.subscribe((ev) => { if (ev.kind === 'cellCommitted') now += 1; });
    await sliced.recalculateAll({ ...OPTS, sliceMs: 8 });
    expect([124, 125]).toContain(yields);
    const plain = createWorkbookEngine(def, formulaOnlyDeps);
    await plain.recalculateAll(OPTS);
    for (const s of def.sheets) for (const c of s.cells) expect(sameValue(sliced.getValue(c.key) as CellValue, plain.getValue(c.key) as CellValue)).toBe(true);
  });

  const N = 5000;
  const fanOut = (): WorkbookDefinition => ({
    sheets: [{ name: 'Load', cells: [{ key: key('Load', 'A1'), raw: '1' }, ...Array.from({ length: N }, (_, i) => ({ key: key('Load', `B${i + 2}`), raw: `=$A$1*${i + 2}` }))] }],
    names: [], datasets: [], seed: 1,
  });

  it('the preamble is sliced: a 5,000-formula fan-out yields before its first commit', async () => {
    const s = slicedDeps();
    const e = createWorkbookEngine(fanOut(), s.deps);
    await e.recalculateAll(OPTS);
    let yieldsAtFirstCommit = -1;
    e.subscribe((ev) => { if (ev.kind === 'cellCommitted' && yieldsAtFirstCommit < 0) yieldsAtFirstCommit = s.yields(); });
    e.applyEdits([{ kind: 'setLiteral', key: key('Load', 'A1'), value: 3 }]);
    await e.recalculate({ ...OPTS, sliceMs: 4 });
    expect(yieldsAtFirstCommit).toBeGreaterThan(0);
    expect(e.getValue(key('Load', `B${N + 1}`))).toBe(3 * (N + 1));
  });

  it('an edit that supersedes a generation mid-preamble hands over the unexpanded frontier', async () => {
    let e: WorkbookEngine | null = null;
    let fired = false;
    let second: Promise<unknown> | null = null;
    const s = slicedDeps(() => {
      if (fired || e === null) return;
      fired = true; // set before recalculate: its own first yield re-enters this hook synchronously
      // The user types again while the first generation is still expanding its dirty set.
      e.applyEdits([{ kind: 'setLiteral', key: key('Load', 'A1'), value: 7 }]);
      second = e.recalculate({ ...OPTS, sliceMs: 4 });
    });
    e = createWorkbookEngine(fanOut(), s.deps);
    await e.recalculateAll(OPTS);
    e.applyEdits([{ kind: 'setLiteral', key: key('Load', 'A1'), value: 3 }]);
    await e.recalculate({ ...OPTS, sliceMs: 4 });
    await second;
    expect(second).not.toBeNull();
    for (const i of [2, 1000, N + 1]) expect(e.getValue(key('Load', `B${i}`))).toBe(7 * i);
  });
});
